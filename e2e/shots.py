import sys
from pywinauto.findwindows import find_elements
from pywinauto import Desktop
from PIL import ImageGrab

name = sys.argv[1]
els = find_elements(title='Nexio', top_level_only=True, backend='uia')
if not els:
    print('NO-WINDOW')
    sys.exit(0)
w = Desktop(backend='uia').window(handle=els[0].handle)
r = w.rectangle()
img = ImageGrab.grab(bbox=(r.left, r.top, r.right, r.bottom))
img.save('artifacts-e2e/' + name + '.png')
print('saved', name, img.size)
