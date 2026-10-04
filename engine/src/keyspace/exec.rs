//! The engine's threads: a fixed number per process, shared by every store, so nothing per thread (stacks,
//! allocator arenas) grows with the number of stores. Work is activities: an activity runs one bounded step per
//! task and goes to the back of the queue if it has more, so stores take turns.
//!
//! Two lanes: an activity whose last step was short (a lone commit's prepare or sync) queues in the front lane,
//! one whose step was long (a large commit, a flush, a merge) in the back lane, taken only when the front is
//! empty. Some threads take the front lane only, so a store committing now and then never waits behind busy
//! stores' long steps; the front lane can't starve the back for long, its steps being short by definition.

use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex, OnceLock, Weak};

type Task = Box<dyn FnOnce() + Send>;

struct Queue {
    front: VecDeque<Task>,
    back: VecDeque<Task>,
    shut: bool,
}

/// A step at most this long keeps its activity in the front lane: a lone commit with its sync on a slow disk.
const SHORT_STEP: std::time::Duration = std::time::Duration::from_millis(5);

struct Inner {
    queue: Mutex<Queue>,
    cv: Condvar,
}

/// The worker threads. Dropping it lets them finish what is queued and exit.
pub struct Executor {
    inner: Arc<Inner>,
}

impl Executor {
    /// `threads` threads, of which `front_only` take only front-lane steps.
    pub fn new(threads: usize, front_only: usize) -> Executor {
        let inner = Arc::new(Inner {
            queue: Mutex::new(Queue {
                front: VecDeque::new(),
                back: VecDeque::new(),
                shut: false,
            }),
            cv: Condvar::new(),
        });
        for i in 0..threads.max(front_only + 1) {
            let inner = inner.clone();
            let front_lane_only = i < front_only;
            std::thread::Builder::new()
                .name(format!("st-engine-{i}"))
                .spawn(move || {
                    loop {
                        let task = {
                            let mut q = inner.queue.lock().unwrap();
                            loop {
                                let t = match q.front.pop_front() {
                                    None if !front_lane_only => q.back.pop_front(),
                                    t => t,
                                };
                                if let Some(t) = t {
                                    break t;
                                }
                                if q.shut {
                                    return;
                                }
                                q = inner.cv.wait(q).unwrap();
                            }
                        };
                        task();
                    }
                })
                .expect("spawning an engine thread");
        }
        Executor { inner }
    }

    fn handle(&self) -> Weak<Inner> {
        Arc::downgrade(&self.inner)
    }
}

impl Drop for Executor {
    fn drop(&mut self) {
        self.inner.queue.lock().unwrap().shut = true;
        self.inner.cv.notify_all();
    }
}

fn spawn_on(exec: &Weak<Inner>, task: Task, front: bool) {
    if let Some(inner) = exec.upgrade() {
        let mut q = inner.queue.lock().unwrap();
        if front {
            q.front.push_back(task);
        } else {
            q.back.push_back(task);
        }
        drop(q);
        // A front-only thread may be the one woken: wake every idle thread for a back-lane step.
        if front {
            inner.cv.notify_one();
        } else {
            inner.cv.notify_all();
        }
    }
}

#[derive(Default)]
struct State {
    /// Queued or running.
    busy: bool,
    /// Kicked while busy: run again.
    again: bool,
    /// The last step was long: queue in the back lane.
    long: bool,
}

/// Work that runs one step at a time on the executor, never two steps at once.
pub struct Activity {
    exec: Weak<Inner>,
    step: OnceLock<Box<dyn Fn() -> bool + Send + Sync>>,
    state: Mutex<State>,
    idle: Condvar,
}

impl Activity {
    pub fn new(exec: &Executor) -> Arc<Activity> {
        Arc::new(Activity {
            exec: exec.handle(),
            step: OnceLock::new(),
            state: Mutex::new(State::default()),
            idle: Condvar::new(),
        })
    }

    /// Sets the step: it does one bounded piece of work and returns whether more is ready now. It must not wait
    /// for other activities; to wait, it registers to be kicked and returns false.
    pub fn set_step(&self, step: Box<dyn Fn() -> bool + Send + Sync>) {
        let _ = self.step.set(step);
    }

    /// Schedules a step, or another one after the running step if it is busy.
    pub fn kick(self: &Arc<Self>) {
        let mut s = self.state.lock().unwrap();
        if s.busy {
            s.again = true;
            return;
        }
        s.busy = true;
        let front = !s.long;
        drop(s);
        let a = self.clone();
        spawn_on(&self.exec, Box::new(move || a.run()), front);
    }

    fn run(self: Arc<Self>) {
        let started = std::time::Instant::now();
        let more = self.step.get().is_some_and(|step| step());
        let long = started.elapsed() > SHORT_STEP;
        let mut s = self.state.lock().unwrap();
        s.long = long;
        if more || s.again {
            s.again = false;
            drop(s);
            let a = self.clone();
            spawn_on(&self.exec, Box::new(move || a.run()), !long);
        } else {
            s.busy = false;
            drop(s);
            self.idle.notify_all();
        }
    }

    /// Waits until no step is queued or running (from outside the executor only).
    pub fn wait_idle(&self) {
        let mut s = self.state.lock().unwrap();
        while s.busy {
            s = self.idle.wait(s).unwrap();
        }
    }
}

/// Activities waiting to be kicked when something frees up.
#[derive(Default)]
pub struct Waiters(Mutex<Vec<Arc<Activity>>>);

impl Waiters {
    /// Runs `ready` under the waiters' lock; if it is false, `a` is kicked at the next `wake`.
    pub fn check_or_wait(&self, a: &Arc<Activity>, ready: impl FnOnce() -> bool) -> bool {
        let mut w = self.0.lock().unwrap();
        if ready() {
            return true;
        }
        if !w.iter().any(|x| Arc::ptr_eq(x, a)) {
            w.push(a.clone());
        }
        false
    }

    pub fn wake(&self) {
        let woken: Vec<_> = std::mem::take(&mut *self.0.lock().unwrap());
        for a in woken {
            a.kick();
        }
    }
}
