//! Deadline-bounded local connection establishment, including a full listen backlog.
use std::{
    io::{self, Read},
    mem,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStrExt, net::UnixStream},
    },
    path::Path,
    time::Instant,
};

pub fn connect(path: &Path, deadline: Instant) -> io::Result<UnixStream> {
    let bytes = path.as_os_str().as_bytes();
    // SAFETY: sockaddr_un is a plain C address structure with no invalid zero state.
    let mut address: libc::sockaddr_un = unsafe { mem::zeroed() };
    if bytes.contains(&0) || bytes.len() >= address.sun_path.len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Invalid lux-ade socket path",
        ));
    }
    address.sun_family = libc::AF_UNIX as _;
    for (slot, byte) in address.sun_path.iter_mut().zip(bytes) {
        *slot = *byte as _;
    }
    let length = mem::offset_of!(libc::sockaddr_un, sun_path) + bytes.len() + 1;
    #[cfg(target_os = "macos")]
    {
        address.sun_len = length as _;
    }
    // SAFETY: socket takes integer constants and returns a new owned descriptor.
    let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fd was just allocated and has no other Rust owner.
    let stream = unsafe { UnixStream::from_raw_fd(fd) };
    stream.set_nonblocking(true)?;
    // SAFETY: fd remains owned by stream; no pointer arguments are used.
    if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|duration| !duration.is_zero())
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::TimedOut,
                    "lux-ade connection deadline elapsed",
                )
            })?;
        // SAFETY: the pointer references the initialized address for its stated length.
        let result = unsafe {
            libc::connect(
                stream.as_raw_fd(),
                &address as *const _ as *const libc::sockaddr,
                length as _,
            )
        };
        if result == 0 {
            break;
        }
        let error = io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::EISCONN) => break,
            Some(libc::EINTR) => continue,
            Some(libc::EAGAIN) => {
                std::thread::sleep(remaining.min(std::time::Duration::from_millis(2)));
                continue;
            }
            Some(libc::EINPROGRESS | libc::EALREADY) => {}
            _ => return Err(error),
        }
        let mut poll = libc::pollfd {
            fd,
            events: libc::POLLOUT,
            revents: 0,
        };
        let timeout = remaining
            .as_millis()
            .saturating_add(1)
            .min(i32::MAX as u128) as i32;
        // SAFETY: poll points at one initialized pollfd for the duration of the call.
        let ready = unsafe { libc::poll(&mut poll, 1, timeout) };
        if ready == 0 {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "lux-ade connection deadline elapsed",
            ));
        }
        if ready < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        let mut pending: libc::c_int = 0;
        let mut size = mem::size_of_val(&pending) as libc::socklen_t;
        // SAFETY: both output pointers reference correctly sized initialized storage.
        if unsafe {
            libc::getsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_ERROR,
                &mut pending as *mut _ as *mut _,
                &mut size,
            )
        } < 0
        {
            return Err(io::Error::last_os_error());
        }
        if pending != 0 {
            return Err(io::Error::from_raw_os_error(pending));
        }
        break;
    }
    stream.set_nonblocking(false)?;
    Ok(stream)
}

/// Read from a blocking local socket with one reader and no SO_RCVTIMEO.
/// The caller may clone the descriptor for shutdown, but must not read through
/// those clones. `None` allows an established stream to remain idle indefinitely.
/// Buffered bytes remain readable after peer closure; HUP is not itself an error.
pub fn read_until(
    stream: &mut UnixStream,
    bytes: &mut [u8],
    deadline: Option<Instant>,
) -> io::Result<usize> {
    if bytes.is_empty() {
        return Ok(0);
    }
    // This is the socket's only reader. Polling before a blocking read bounds
    // startup without changing SO_RCVTIMEO, which macOS may reject after peer
    // closure even while final output remains buffered. HUP still permits read.
    while let Some(deadline) = deadline {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "lux-ade read deadline elapsed",
                )
            })?;
        let mut descriptor = libc::pollfd {
            fd: stream.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        let timeout = remaining
            .as_millis()
            .saturating_add(1)
            .min(i32::MAX as u128) as i32;
        // SAFETY: descriptor is initialized and its owned socket remains live
        // throughout this call. No other task reads from the cloned descriptor.
        let ready = unsafe { libc::poll(&mut descriptor, 1, timeout) };
        if ready > 0 {
            break;
        }
        if ready < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
        // Timeout or signal: recompute the remaining absolute deadline.
    }
    stream.read(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deadline_and_invalid_paths_fail_without_blocking() {
        let error =
            connect(Path::new("/tmp/ade-unused-deadline.sock"), Instant::now()).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert_eq!(
            connect(
                Path::new(&"x".repeat(256)),
                Instant::now() + std::time::Duration::from_secs(1)
            )
            .unwrap_err()
            .kind(),
            io::ErrorKind::InvalidInput
        );
    }
    #[test]
    fn established_stream_can_exchange_data() {
        use std::io::{Read, Write};
        let path = std::env::temp_dir().join(format!(
            "ade-ipc-{}-{}.sock",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        // macOS temporary directories may exceed sockaddr_un's path limit.
        let path = Path::new("/tmp").join(path.file_name().unwrap());
        let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
        let mut client =
            connect(&path, Instant::now() + std::time::Duration::from_secs(1)).unwrap();
        let (mut server, _) = listener.accept().unwrap();
        client.write_all(b"ok").unwrap();
        let mut bytes = [0; 2];
        server.read_exact(&mut bytes).unwrap();
        assert_eq!(&bytes, b"ok");
        std::fs::remove_file(path).unwrap();
    }
}
