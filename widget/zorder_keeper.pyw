import ctypes
import json
import os
import time

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_NOACTIVATE = 0x0010
GW_HWNDPREV = 3
SW_SHOWNOACTIVATE = 4
SW_RESTORE = 9

user32.SetWindowPos.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_uint]
user32.GetWindow.argtypes = [ctypes.c_void_p, ctypes.c_uint]
user32.GetWindow.restype = ctypes.c_void_p
user32.IsWindow.argtypes = [ctypes.c_void_p]
user32.IsWindow.restype = ctypes.c_bool
user32.IsIconic.argtypes = [ctypes.c_void_p]
user32.IsIconic.restype = ctypes.c_bool
user32.ShowWindow.argtypes = [ctypes.c_void_p, ctypes.c_int]
user32.GetForegroundWindow.restype = ctypes.c_void_p
user32.FindWindowW.restype = ctypes.c_void_p
user32.GetWindowThreadProcessId.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
user32.GetWindowThreadProcessId.restype = ctypes.c_ulong

state_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.hwnd')


def load_state(timeout_s=60.0):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            with open(state_path, 'r', encoding='utf-8') as f:
                d = json.load(f)
            if d.get('hwnd') and d.get('pid'):
                return int(d['hwnd']), int(d['pid'])
        except Exception:
            pass
        time.sleep(0.5)
    return None, None


def main():
    hwnd, pid = load_state()
    if not hwnd:
        return
    wid = ctypes.c_ulong(0)
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(wid))
    if wid.value != pid:
        return

    progman = user32.FindWindowW('Progman', None) or user32.FindWindowW('WorkerW', None)
    if not progman:
        return

    while True:
        try:
            if not os.path.exists(state_path):
                return
            if not user32.IsWindow(hwnd):
                return
            wid = ctypes.c_ulong(0)
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(wid))
            if wid.value != pid:
                return

            if user32.IsIconic(hwnd):
                user32.ShowWindow(hwnd, SW_RESTORE)

            if user32.GetForegroundWindow() != hwnd:
                prev = user32.GetWindow(progman, GW_HWNDPREV)
                target = prev if prev and prev != hwnd else progman
                user32.SetWindowPos(
                    hwnd, target, 0, 0, 0, 0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                )
            time.sleep(0.8)
        except Exception:
            time.sleep(1.0)


if __name__ == '__main__':
    main()
