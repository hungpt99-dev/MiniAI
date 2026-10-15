import time
from pywinauto import keyboard, Desktop
from pywinauto.findwindows import find_elements

def n():
    return len(find_elements(title='Nexio', top_level_only=True, backend='uia'))
keyboard.send_keys('%x')
time.sleep(0.6)
print('after-hotkey:', n())
els = find_elements(title='Nexio', top_level_only=True, backend='uia')
if els:
    w = Desktop(backend='uia').window(handle=els[0].handle)
    r = w.rectangle()
    print('rect:', r.left, r.top, r.right, r.bottom)
    from pywinauto import mouse
    mouse.click(coords=(r.left + 240, r.top + 100))
    time.sleep(1.0)
    print('after-click:', n())
    print('focused:', Desktop(backend='uia').window(handle=els[0].handle).has_focus() if n() else 'gone')
