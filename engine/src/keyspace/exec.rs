//! The engine's threads: a fixed number per process, shared by every store, so nothing per thread (stacks,
//! allocator arenas) grows with the number of stores. Work is activities: an activity runs one bounded step per
//! task and goes to the back of the queue if it has more, so stores take turns.
//!
//! Two lanes: an activity whose last step was short (a lone commit's prepare or sync) queues in the front lane,
//! one whose step was long (a large commit, a flush, a merge) in the back lane, taken only when the front is
//! empty. Some threads take the front lane only, so a store committing now and then never waits behind busy
//! stores' long steps; the front lane can't starve the back for long, its steps being short by definition.
//!
//! Simulation (`Executor::simulated`, for tests): no threads. Steps run on the thread that waits for them, one at
//! a time, the next one picked from everything queued (either lane) by a seeded generator, so a seed fixes the
//! whole interleaving of steps and a failure replays exactly. Every wait in the engine (`wait`, `recv`,
//! `Activity::wait_idle`) runs queued steps instead of blocking; one with nothing queued is a deadlock and
//! panics. Steps are atomic there: what two steps running at once on real threads could do between each other's
//! lines is not explored.

use std::collections::VecDeque;
use std::sync::mpsc::{Receiver, TryRecvError};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock, Weak};

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
    /// Under simulation: the generator picking the next step, and how many steps ran.
    sim: Option<Mutex<Sim>>,
}

struct Sim {
    state: u64,
    steps: u64,
    /// Fixed per seed, so seeds cover both prompt and lagging background work: of a back-lane step against a
    /// front-lane one (both queued), the odds in 32 that the back one runs next; and the most extra steps a wait
    /// runs first (`pump_some`).
    back_odds: usize,
    eager: usize,
}

impl Sim {
    fn next(&mut self, n: usize) -> usize {
        // splitmix64
        self.state = self.state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        ((z ^ (z >> 31)) % n as u64) as usize
    }
}

impl Inner {
    /// Under simulation, runs one queued step picked by the seed; false when none is queued (or not simulated).
    fn pump(&self) -> bool {
        let Some(sim) = &self.sim else { return false };
        let task = {
            let mut q = self.queue.lock().unwrap();
            let n = q.front.len() + q.back.len();
            if n == 0 {
                return false;
            }
            let mut s = sim.lock().unwrap();
            s.steps += 1;
            let back = q.front.is_empty() || (!q.back.is_empty() && s.next(32) < s.back_odds);
            let lane = if back { &mut q.back } else { &mut q.front };
            let i = s.next(lane.len());
            drop(s);
            lane.remove(i).unwrap()
        };
        task();
        true
    }

    /// Under simulation, before a wait looks at what it waits for: a few queued steps picked by the seed (up to the
    /// seed's `eager`), so background work lands between the caller's operations, not only where it waits on it.
    fn pump_some(&self) {
        let Some(sim) = &self.sim else { return };
        let n = {
            let mut s = sim.lock().unwrap();
            let e = s.eager;
            s.next(e + 1)
        };
        for _ in 0..n {
            if !self.pump() {
                return;
            }
        }
    }

    fn pump_or_deadlock(&self) {
        assert!(
            self.pump(),
            "simulated engine deadlock: a wait with no step queued that could end it"
        );
    }
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
            sim: None,
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

    /// No threads: steps run, picked by `seed`, on whichever thread waits for them (see the module's doc).
    pub fn simulated(seed: u64) -> Executor {
        Executor {
            inner: Arc::new(Inner {
                queue: Mutex::new(Queue {
                    front: VecDeque::new(),
                    back: VecDeque::new(),
                    shut: false,
                }),
                cv: Condvar::new(),
                sim: Some(Mutex::new({
                    let mut s = Sim {
                        state: seed,
                        steps: 0,
                        back_odds: 16,
                        eager: 0,
                    };
                    s.back_odds = [16, 4, 1][s.next(3)];
                    s.eager = [0, 1, 3, 8][s.next(4)];
                    s
                })),
            }),
        }
    }

    pub fn is_simulated(&self) -> bool {
        self.inner.sim.is_some()
    }

    /// Under simulation, runs one queued step; false when none is queued (or not simulated).
    pub fn pump(&self) -> bool {
        self.inner.pump()
    }

    /// Under simulation, runs queued steps until none is left; how many ran.
    pub fn run_until_quiet(&self) -> u64 {
        let mut n = 0;
        while self.inner.pump() {
            n += 1;
        }
        n
    }

    /// Steps run so far under simulation (0 otherwise).
    pub fn sim_steps(&self) -> u64 {
        self.inner
            .sim
            .as_ref()
            .map_or(0, |s| s.lock().unwrap().steps)
    }

    /// Waits on `cv` for `g` (of `m`); under simulation runs a queued step instead, and returns `m` locked again.
    pub fn wait<'a, T>(
        &self,
        m: &'a Mutex<T>,
        cv: &Condvar,
        g: MutexGuard<'a, T>,
    ) -> MutexGuard<'a, T> {
        if self.inner.sim.is_none() {
            return cv.wait(g).unwrap();
        }
        drop(g);
        self.inner.pump_or_deadlock();
        self.inner.pump_some();
        m.lock().unwrap()
    }

    /// Receives from `rx`; under simulation runs queued steps until something arrives.
    pub fn recv<T>(&self, rx: &Receiver<T>) -> Option<T> {
        if self.inner.sim.is_none() {
            return rx.recv().ok();
        }
        self.inner.pump_some();
        loop {
            match rx.try_recv() {
                Ok(v) => return Some(v),
                Err(TryRecvError::Disconnected) => return None,
                Err(TryRecvError::Empty) => self.inner.pump_or_deadlock(),
            }
        }
    }

    /// Lets time pass for something polled: sleeps `d`, or under simulation runs a queued step (none: returns).
    pub fn pause(&self, d: std::time::Duration) {
        if self.inner.sim.is_none() {
            std::thread::sleep(d);
        } else {
            self.inner.pump();
        }
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
        // Under simulation nothing depends on time: an activity stays in the lane it started in.
        let simulated = self.exec.upgrade().is_some_and(|i| i.sim.is_some());
        let long = !simulated && started.elapsed() > SHORT_STEP;
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
        let sim = self.exec.upgrade().filter(|i| i.sim.is_some());
        if let Some(inner) = &sim {
            inner.pump_some();
        }
        let mut s = self.state.lock().unwrap();
        while s.busy {
            match &sim {
                None => s = self.idle.wait(s).unwrap(),
                Some(inner) => {
                    drop(s);
                    inner.pump_or_deadlock();
                    s = self.state.lock().unwrap();
                }
            }
        }
    }
}

/// Tests: the seeds a simulated test runs. `ST_SIM_SEED=<s>` runs s alone (to replay a failure); otherwise
/// `ST_SIM_SEEDS` seeds (default `default`) from `ST_SIM_BASE` (default 1).
#[cfg(test)]
pub fn sim_seeds(default: u64) -> Vec<u64> {
    let var = |name: &str| std::env::var(name).ok().and_then(|s| s.parse::<u64>().ok());
    if let Some(s) = var("ST_SIM_SEED") {
        return vec![s];
    }
    let base = var("ST_SIM_BASE").unwrap_or(1);
    (base..base + var("ST_SIM_SEEDS").unwrap_or(default)).collect()
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
