"""macOS helper: count on-screen top-level Nexio/MiniAI windows. Prints N:0/N:1."""
import Quartz

lst = Quartz.CGWindowListCopyWindowInfo(
    Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements,
    Quartz.kCGNullWindowID)
n = sum(1 for w in lst if str(w.get('kCGWindowName', '')) in ('Nexio', 'MiniAI'))
print('N:' + str(n))
