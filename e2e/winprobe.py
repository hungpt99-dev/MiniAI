import sys, time
from pywinauto import Desktop, keyboard
from pywinauto.findwindows import find_elements

els = find_elements(title='MiniAI', top_level_only=True, backend='uia')
print('matches:', len(els))
d = Desktop(backend='uia')
for e in els:
    w = d.window(handle=e.handle)
    print('handle', e.handle, 'visible=' + str(w.is_visible()))
if len(sys.argv) > 1 and sys.argv[1] == 'hotkey':
    keyboard.send_keys('%{SPACE}')
    time.sleep(1.5)
    els = find_elements(title='MiniAI', top_level_only=True, backend='uia')
    for e in els:
        w = d.window(handle=e.handle)
        print('AFTER handle', e.handle, 'visible=' + str(w.is_visible()))
