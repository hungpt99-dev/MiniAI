import sys, time
from pywinauto import keyboard
from pywinauto.findwindows import find_elements

key = sys.argv[1] if len(sys.argv) > 1 else '%{SPACE}'
els = find_elements(title='MiniAI', top_level_only=True, backend='uia')
print('before:', len(els))
keyboard.send_keys(key)
time.sleep(1.5)
els = find_elements(title='MiniAI', top_level_only=True, backend='uia')
print('after:', len(els))
