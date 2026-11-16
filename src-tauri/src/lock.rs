//! One poison-tolerant way to lock a std `Mutex`.

use std::sync::{Mutex, MutexGuard, PoisonError};

/// Locks `mutex`, carrying on with the data as it was left if a thread panicked while holding
/// it. The state behind these locks stays usable, so one panic must not make every later call
/// panic too.
pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn locks_a_mutex_a_panic_poisoned() {
        let mutex = Arc::new(Mutex::new(1));
        let held = mutex.clone();
        let _ = std::thread::spawn(move || {
            let mut guard = held.lock().unwrap();
            *guard = 2;
            panic!("poison the lock");
        })
        .join();
        assert!(mutex.is_poisoned());
        assert_eq!(*lock(&mutex), 2);
    }
}
