//! Native members of `Bun.ant` for Claude Code running on Node.
//!
//! The bundle reaches for a handful of OS calls through `Bun.ant`, a native
//! namespace of the Bun build it ships in. Under Node the namespace is the
//! polyfill's, and where a member is missing the bundle takes a slower
//! fallback — or none. Each function here takes the place of one member,
//! with the signature and return type the bundle's call sites expect; the
//! polyfill attaches whichever this build exports.

#[cfg(windows)]
use napi::bindgen_prelude::BigInt;
#[cfg(windows)]
use napi_derive::napi;

/// `Bun.ant.windowsProcessCreationTime(pid)`: the process's creation time as
/// a FILETIME — 100ns intervals since 1601-01-01 UTC — or `null` when the
/// process cannot be opened.
///
/// Without it the bundle asks PowerShell for the same instant
/// (`Get-CimInstance Win32_Process … .CreationDate.Ticks`), which costs
/// ~570ms on the interactive start: the session key the messaging inbox
/// publishes waits on it (#20). The call sites subtract the FILETIME epoch
/// offset as a BigInt and stringify the value into that key, so it has to
/// be a BigInt, and the exact FILETIME the official build would publish.
#[cfg(windows)]
#[napi(js_name = "windowsProcessCreationTime")]
pub fn windows_process_creation_time(pid: u32) -> Option<BigInt> {
    win::creation_time(pid).map(BigInt::from)
}

#[cfg(windows)]
mod win {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    pub fn creation_time(pid: u32) -> Option<u64> {
        if pid == 0 {
            return None;
        }
        // Limited information is the least access GetProcessTimes accepts,
        // and is granted for elevated and other users' processes too, which
        // the WMI and Get-Process routes are not reliably.
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            return None;
        }
        let zero = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
        let ok = unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) };
        unsafe { CloseHandle(handle) };
        if ok == 0 {
            return None;
        }
        Some((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
    }
}
