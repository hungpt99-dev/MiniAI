"""macOS helper: capture the Nexio popup window. Prints 'saved NAME (w, h)'."""
import subprocess
import sys

import Quartz

# argv when exec'd by the suite: ['x', NAME]. Direct CLI: [script, x, NAME].
args = sys.argv[1:]
if len(args) > 1:
    args = args[1:]
name = args[0] if args else 'shot'

lst = Quartz.CGWindowListCopyWindowInfo(
    Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements,
    Quartz.kCGNullWindowID)
wins = [w for w in lst if str(w.get('kCGWindowName', '')) in ('Nexio', 'MiniAI')]
if not wins:
    print('NO-WINDOW')
    sys.exit(0)
w = wins[0]
b = w.get('kCGWindowBounds', {})
r = subprocess.run(
    ['screencapture', '-x', '-l%d' % w.get('kCGWindowNumber'), 'artifacts-e2e/' + name + '.png'],
    capture_output=True)
if r.returncode != 0:
    print('SHOT-FAILED ' + r.stderr.decode().strip()[:200])
    sys.exit(1)
print('saved', name, '(%d, %d)' % (int(b.get('Width', 0)), int(b.get('Height', 0))))
