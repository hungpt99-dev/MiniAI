import time
from pywinauto import keyboard
from pywinauto.findwindows import find_elements

def n():
    return len(find_elements(title='MiniAI', top_level_only=True, backend='uia'))
print('start:', n())
keyboard.send_keys('%x')
for i in range(16):
    time.sleep(0.3)
    print(f't+{(i+1)*0.3:.1f}s:', n())
