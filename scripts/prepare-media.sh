#!/usr/bin/env bash
#
# prepare-media.sh — make any .mkv / .mp4 / .avi ready for Polystream (browser direct-play).
#
# It probes the file and does the minimum needed to produce a faststart .mp4 that the app can
# stream with instant start + seeking:
#   • video : H.264 8-bit is copied as-is (lossless); 10-bit H.264 or anything else is
#             re-encoded to 8-bit H.264. HEVC/H.265 is kept by default (best quality; plays on
#             capable devices — the app can make an H.264 fallback on demand). Use --to-h264 to
#             force HEVC → H.264 for universal playback.
#   • audio : downmixed to stereo AAC by default — multichannel (5.1/7.1) AAC plays in Safari
#             and Chrome but often NOT in Firefox, so stereo is the only choice that plays
#             identically everywhere. Already-stereo/mono AAC is copied losslessly; everything
#             else is re-encoded to stereo AAC. Use --surround to KEEP the original channels
#             (best on capable setups, at the cost of Firefox compatibility).
#   • subs  : embedded TEXT subtitles are carried into the .mp4 as mov_text. Bitmap subs
#             (PGS/VobSub) can't live in .mp4 and are dropped (keep those as external .srt).
#   • always: -movflags +faststart (index at the front → instant start + partial download).
#
# External ".srt" sidecar files are NOT touched — the app serves them directly; just keep the
# base filename the same so it can still pair them.
#
# Usage:
#   scripts/prepare-media.sh [--to-h264] [--surround] FILE [FILE ...]
#
# Output: "<name>.mp4" next to each input. For an .mkv/.avi the source is left in place; for an
# .mp4 input the file is replaced in place (after a successful, verified conversion).

set -euo pipefail

TO_H264=0
SURROUND=0
FILES=()

usage() {
	sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
	exit "${1:-0}"
}

while [ $# -gt 0 ]; do
	case "$1" in
		--to-h264) TO_H264=1 ;;
		--surround) SURROUND=1 ;;
		-h | --help) usage 0 ;;
		-*) echo "Unknown option: $1" >&2; usage 1 ;;
		*) FILES+=("$1") ;;
	esac
	shift
done

[ ${#FILES[@]} -gt 0 ] || usage 1

for cmd in ffmpeg ffprobe; do
	command -v "$cmd" >/dev/null 2>&1 || { echo "Error: '$cmd' not found on PATH." >&2; exit 1; }
done

# Text subtitle codecs ffmpeg can convert to mov_text; everything else (bitmap) is dropped.
is_text_sub() {
	case "$1" in
		subrip | srt | ass | ssa | mov_text | webvtt | text | subviewer | subviewer1 | jacosub | microdvd) return 0 ;;
		*) return 1 ;;
	esac
}

probe() { # probe FILE STREAM_SELECTOR ENTRY  ->  prints value (empty if absent)
	ffprobe -v error -select_streams "$2" -show_entries "stream=$3" -of default=nw=1:nk=1 "$1" 2>/dev/null | head -n1
}

prepare_one() {
	local f="$1"
	if [ ! -f "$f" ]; then
		echo "  ✗ not found: $f" >&2
		return 1
	fi

	local ext
	ext="$(printf '%s' "${f##*.}" | tr '[:upper:]' '[:lower:]')"
	case "$ext" in
		mkv | mp4 | avi) ;;
		*) echo "  ✗ skipped (not mkv/mp4/avi): $f" >&2; return 1 ;;
	esac

	local vcodec pixfmt acodec alayout
	vcodec="$(probe "$f" v:0 codec_name)"
	pixfmt="$(probe "$f" v:0 pix_fmt)"
	acodec="$(probe "$f" a:0 codec_name)"
	achannels="$(probe "$f" a:0 channels)"

	if [ -z "$vcodec" ]; then
		echo "  ✗ no video stream found (file busy or unreadable?): $f" >&2
		return 1
	fi

	# --- video decision ---
	local -a vargs
	local vnote
	if [ "$vcodec" = "h264" ] && [ "$pixfmt" = "yuv420p" ]; then
		vargs=(-c:v copy)
		vnote="H.264 8-bit (copy)"
	elif [ "$vcodec" = "hevc" ] && [ "$TO_H264" -eq 0 ]; then
		vargs=(-c:v copy)
		vnote="HEVC kept (copy) — plays on capable devices; --to-h264 for universal"
	else
		vargs=(-c:v libx264 -pix_fmt yuv420p -crf 20 -preset medium)
		case "$vcodec" in
			h264) vnote="H.264 ${pixfmt} → re-encode to 8-bit H.264" ;;
			hevc) vnote="HEVC → re-encode to H.264 (--to-h264)" ;;
			*) vnote="${vcodec} → re-encode to H.264" ;;
		esac
	fi

	# --- audio decision ---
	# Default target is stereo AAC: multichannel AAC is a cross-browser hazard (Firefox often
	# can't decode >2 channels), so stereo is the only "plays identically everywhere" choice.
	# --surround keeps the original channels for setups known to handle them.
	local -a aargs=()
	local anote="(no audio)"
	local ch="${achannels:-0}"
	if [ -n "$acodec" ]; then
		if [ "$SURROUND" -eq 1 ]; then
			# Keep channels. Copy clean AAC; otherwise re-encode, scaling bitrate for multichannel.
			if [ "$acodec" = "aac" ]; then
				aargs=(-c:a copy)
				anote="AAC ${ch}ch (copy, --surround)"
			else
				local br=192k
				[ "$ch" -gt 2 ] && br=384k
				aargs=(-c:a aac -b:a "$br")
				anote="${acodec} ${ch}ch → AAC ${ch}ch (--surround)"
			fi
		elif [ "$acodec" = "aac" ] && [ "$ch" -ge 1 ] && [ "$ch" -le 2 ]; then
			# Already stereo/mono AAC — copy losslessly.
			aargs=(-c:a copy)
			anote="AAC ${ch}ch (copy)"
		else
			# Non-AAC, or multichannel → downmix to stereo AAC (plays in every browser).
			aargs=(-c:a aac -b:a 192k -ac 2)
			anote="${acodec} ${ch}ch → AAC stereo"
		fi
	fi

	# --- subtitle decision: map only TEXT subtitle streams (by subtitle-relative index) ---
	local -a smaps=()
	local -a scodec=()
	local sub_i=0 sub_count=0 c
	while IFS= read -r c; do
		[ -n "$c" ] || continue
		if is_text_sub "$c"; then
			smaps+=(-map "0:s:${sub_i}")
			sub_count=$((sub_count + 1))
		fi
		sub_i=$((sub_i + 1))
	done < <(ffprobe -v error -select_streams s -show_entries stream=codec_name -of default=nw=1:nk=1 "$f" 2>/dev/null)
	[ "$sub_count" -gt 0 ] && scodec=(-c:s mov_text)

	echo "→ $(basename "$f")"
	echo "    video: $vnote"
	echo "    audio: $anote"
	echo "    subs : ${sub_count} text track(s) kept$([ "$sub_i" -gt "$sub_count" ] && echo ", $((sub_i - sub_count)) bitmap dropped")"

	local base="${f%.*}"
	local out="${base}.mp4"
	local tmp="${base}.prep-tmp.$$.mp4"

	# `${arr[@]+"${arr[@]}"}` is the bash-3.2-safe way to expand a possibly-empty array under
	# `set -u` (macOS ships bash 3.2, where a bare "${empty[@]}" errors as an unbound variable).
	if ! ffmpeg -y -v error -stats -i "$f" \
		-map 0:v:0 -map 0:a:0? ${smaps[@]+"${smaps[@]}"} \
		"${vargs[@]}" ${aargs[@]+"${aargs[@]}"} ${scodec[@]+"${scodec[@]}"} \
		-movflags +faststart "$tmp"; then
		rm -f "$tmp"
		echo "    ✗ ffmpeg failed" >&2
		return 1
	fi

	# Verify the output is genuinely browser-safe before replacing/keeping it.
	local out_pix out_vcodec
	out_vcodec="$(probe "$tmp" v:0 codec_name)"
	out_pix="$(probe "$tmp" v:0 pix_fmt)"
	if { [ "$out_vcodec" = "h264" ] && [ "$out_pix" != "yuv420p" ]; } || [ -z "$out_vcodec" ]; then
		rm -f "$tmp"
		echo "    ✗ output failed verification (codec=$out_vcodec pix_fmt=$out_pix)" >&2
		return 1
	fi

	mv -f "$tmp" "$out"
	if [ "$out" = "$f" ]; then
		echo "    ✓ replaced in place: $out"
	else
		echo "    ✓ wrote: $out  (source kept: $f)"
	fi
}

rc=0
for f in "${FILES[@]}"; do
	prepare_one "$f" || rc=1
done
exit "$rc"
