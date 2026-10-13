import time, sys
from pywinauto import keyboard
from pywinauto.findwindows import find_elements

want = sys.argv[1] if len(sys.argv) > 1 else 'show'  # show | hide
key = sys.argv[2] if len(sys.argv) > 2 else '%{SPACE}'
def n():
    return len(find_elements(title='MiniAI', top_level_only=True, backend='uia'))
# poll for the target state instead of fixed sleeps: window creation after a
# destroy-close is slower than a plain show, and re-toggling too early hides it again.
# (No mouse click: focusing is the app's job via its focus handler + suite ensureInput;
# a stray click can blur-hide the popup.)
for _ in range(6):
    cur = n()
    if (want == 'show' and cur == 1) or (want == 'hide' and cur == 0):
        break
    keyboard.send_keys(key)
    for _ in range(20):
        time.sleep(0.25)
        cur = n()
        if (want == 'show' and cur == 1) or (want == 'hide' and cur == 0):
            break
time.sleep(0.4)
print('N:' + str(n()))
