"""macOS helper: post the toggle hotkey and poll for the wanted window state.
argv: [x, show|hide, keyspec]  keyspec like 'ctrl+alt+space' (last part = key).
Mirrors e2e/hotkey_show.py polling so the suite stays in sync with the app.
"""
import subprocess
import sys
import time

import Quartz

# argv when exec'd by the suite: ['x', show|hide, keyspec].
# argv on a direct CLI call: [script, x, show|hide, keyspec].
args = sys.argv[1:]
if args and args[0] not in ('show', 'hide'):
    args = args[1:]
WANT = args[0] if len(args) > 0 else 'show'  # show | hide
SPEC = args[1] if len(args) > 1 else 'alt+space'

KEYCODES = {
    'space': 49, 'tab': 48, 'enter': 36, 'escape': 53, 'delete': 51,
    'a': 0, 'b': 11, 'c': 8, 'd': 2, 'e': 14, 'f': 3, 'g': 5, 'h': 4,
    'i': 34, 'j': 38, 'k': 40, 'l': 37, 'm': 46, 'n': 45, 'o': 31,
    'p': 35, 'q': 12, 'r': 15, 's': 1, 't': 17, 'u': 32, 'v': 9,
    'w': 13, 'x': 7, 'y': 16, 'z': 6,
    '0': 29, '1': 18, '2': 19, '3': 20, '4': 21, '5': 23,
    '6': 22, '7': 26, '8': 28, '9': 25,
}
MODFLAGS = {
    'ctrl': Quartz.kCGEventFlagMaskControl,
    'control': Quartz.kCGEventFlagMaskControl,
    'alt': Quartz.kCGEventFlagMaskAlternate,
    'option': Quartz.kCGEventFlagMaskAlternate,
    'command': Quartz.kCGEventFlagMaskCommand,
    'cmd': Quartz.kCGEventFlagMaskCommand,
    'shift': Quartz.kCGEventFlagMaskShift,
}


def n():
    lst = Quartz.CGWindowListCopyWindowInfo(
        Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements,
        Quartz.kCGNullWindowID)
    return sum(1 for w in lst if str(w.get('kCGWindowName', '')) in ('Nexio',))


def post():
    parts = [p for p in SPEC.lower().split('+') if p]
    key_name, mods = parts[-1], parts[:-1]
    code = KEYCODES.get(key_name)
    if code is None:
        print('BAD-KEYSPEC ' + SPEC)
        return
    flags = 0
    for m in mods:
        flags |= MODFLAGS.get(m, 0)
    src = Quartz.CGEventSourceCreate(Quartz.kCGEventSourceStateHIDSystemState)
    down = Quartz.CGEventCreateKeyboardEvent(src, code, True)
    up = Quartz.CGEventCreateKeyboardEvent(src, code, False)
    if flags:
        Quartz.CGEventSetFlags(down, flags)
        Quartz.CGEventSetFlags(up, flags)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, down)
    time.sleep(0.05)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, up)


def settled():
    cur = n()
    return (WANT == 'show' and cur == 1) or (WANT == 'hide' and cur == 0)


# Same polling shape as the Windows helper: window creation after a
# destroy-close is slower than a plain show, and re-toggling too early
# hides it again.
for _ in range(6):
    if settled():
        break
    post()
    for _ in range(20):
        time.sleep(0.25)
        if settled():
            break
time.sleep(0.4)
print('N:' + str(n()))
