# Tatami Galaxy style references

Every `scene` picture and every animated `person` is generated with up to THREE of these images attached
(the palette's own image first, then the next ones of the ring below).

Included by default (3 of the 6, so nothing has to be added):

    tatami-pink.jpg               pink arcade street
    tatami-sepia.jpg              brown corridor, girl with a bob
    tatami-muted_multicolor.jpg   dark study room with pink / yellow / purple ghost figures

You can add more later (JPG, the names must match exactly) and they are picked up automatically:

    tatami-blue_grey.jpg
    tatami-green.jpg
    tatami-black_yellow.jpg

Ring order: blue_grey, sepia, pink, green, black_yellow, muted_multicolor.
A palette whose own file is missing (for example `green`) starts from the next file that exists.
Only when NO file is in this folder does the images step stop and ask for them.
