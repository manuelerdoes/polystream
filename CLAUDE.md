we're building a web app that streams videofiles from a webdav source.

the app displays tv shows and videos in an appealing and easy to use way. the webdav contains folders and has the following structure:

- root
  - movies
    - movie
  - tv shows
    - tv show
      - season 1
      - season 2
      - <and so on>

the video files may contain subtitles. but the subtitles can also be present as separate .srt files.

the video formats may be:
mkv, mp4 or avi
they may contain 264 or 265 encoded video

the app should make use of state of the art video streaming methods to give the user the best possible experience. (fast loading, best possible quality)

the authentication to the app is very simple: there is one hardcoded password, all the users need to know.

if it makes the user experience smoother the app may be able to cache some files. but there is not a big amount of storage available on the server that hosts the app. tell me what you think about this.

the ui of the app is simple. choose the movie or show. choose the season and episode. play. turn on or off subtitles and change language of subtitle if available.

## tech used

svelte kit -> if svelte / svelte kit has a solution for a problem do use it. try to work according to svelte best practices and recommendations. use the newest versions of everything you can. tell me if for some reason you have to use an older version of a package.

## rules

talk to me. if there are things you don't know that I might know -> ask me, do not assume.

always write plans into an md file.

do not make big changes without asking me.

use sonnet subagents for big coding tasks to save tokens.
