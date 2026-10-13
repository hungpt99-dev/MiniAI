import subprocess
out = subprocess.run(['powershell', '-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Select-Object ProcessId,CommandLine | Format-List"],
    capture_output=True, text=True)
print(out.stdout[-3000:])
