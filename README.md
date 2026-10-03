# Reddit Quality of Life Userscript

# Features
- improved image viewer. On click on image in feeds or in comments a modal pops up. Scroll to zoom in/out, drag to pan while zoomed, click outside to close, buttons to go to next/prev, inclidng keyboard left/right. Overrides built-in
- gifs in comments show a frame instead of a black square: each gif is downloaded and pinned to its first frame as soon as it scrolls into view (not earlier), and still plays on click
- sort by top: hovering Top in the sort dropdown expands a nested time-range submenu (Now/Today/Week/Month/Year/All); picking a range swaps the feed in place (no page reload)
- show user (post author) on the home feed: u/name link in the post credit bar (author comes from shreddit-post[author])
- load comments in thread without reloading for any nested level: a deep "N more replies" fold expands in place (the link shows a spinner while the slice renders, then the spent link disappears)
- deep reply chains stay readable: as soon as a comment gets narrower than 250px, its reply container is pulled back to the width and position of a top-level comment, so the rest of the thread below it is full width again
