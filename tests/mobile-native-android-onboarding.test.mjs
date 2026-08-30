import test from 'node:test';
import assert from 'node:assert/strict';
import {
  certifyGuestProfileAcrossRestart,
  expectedGuestProfileIsStable,
  synchronizeGuestOnboarding,
} from '../.github/validation/native-android-onboarding.mjs';

const persistedGuestState = () => ({
  dialogVisible: false,
  inputValues: [],
  submitEnabled: false,
  profileReady: true,
  localProfile: JSON.stringify({
    displayName: 'Android Smoke',
    phoneNumber: '0501234567',
  }),
  localPhone: '0501234567',
  accountScope: 'guest',
});

function createClock() {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms) => {
      current += ms;
    },
    elapsed: () => current,
  };
}

class DelayedOnboardingController {
  constructor() {
    this.reads = 0;
    this.dialogVisible = false;
    this.inputValues = ['', ''];
    this.submitEnabled = false;
    this.submitted = false;
    this.postSubmitReads = 0;
    this.profileReady = false;
  }

  async readState() {
    this.reads += 1;
    if (!this.dialogVisible && !this.submitted && this.reads >= 4) {
      this.dialogVisible = true;
    }
    if (this.submitted) {
      this.postSubmitReads += 1;
      if (this.postSubmitReads >= 2) {
        this.dialogVisible = false;
        this.profileReady = true;
      }
    }
    return {
      dialogVisible: this.dialogVisible,
      inputValues: [...this.inputValues],
      submitEnabled: this.submitEnabled,
      profileReady: this.profileReady,
      localProfile: this.profileReady
        ? JSON.stringify({ displayName: 'Android Smoke', phoneNumber: '0501234567' })
        : null,
      localPhone: this.profileReady ? '0501234567' : null,
      accountScope: 'guest',
    };
  }

  async fillFields(displayName, phoneNumber) {
    if (!this.dialogVisible) return false;
    this.inputValues = [displayName, phoneNumber];
    this.submitEnabled = displayName === 'Android Smoke' && phoneNumber === '0501234567';
    return true;
  }

  async submit() {
    if (!this.dialogVisible || !this.submitEnabled) return false;
    this.submitted = true;
    return true;
  }
}

test('guest onboarding synchronization waits for a dialog that appears after hydration', async () => {
  const controller = new DelayedOnboardingController();
  const clock = createClock();

  const result = await synchronizeGuestOnboarding(controller, {
    timeoutMs: 5_000,
    intervalMs: 100,
    ...clock,
  });

  assert.equal(result.outcome, 'completed');
  assert.ok(controller.reads >= 6, 'the delayed dialog and delayed persistence were both polled');
  assert.deepEqual(controller.inputValues, ['Android Smoke', '0501234567']);
  assert.equal(controller.submitted, true);
  assert.equal(controller.profileReady, true);
  assert.equal(controller.dialogVisible, false);
  assert.ok(clock.elapsed() >= 1_500, 'synchronization includes the WebView disk-flush window');
});

test('guest onboarding synchronization leaves an already-persisted profile untouched', async () => {
  let fillCalls = 0;
  let submitCalls = 0;
  const controller = {
    readState: async () => persistedGuestState(),
    fillFields: async () => {
      fillCalls += 1;
      return true;
    },
    submit: async () => {
      submitCalls += 1;
      return true;
    },
  };

  const result = await synchronizeGuestOnboarding(controller, {
    timeoutMs: 1_000,
    intervalMs: 10,
    durabilityWindowMs: 20,
  });

  assert.equal(result.outcome, 'already-complete');
  assert.equal(fillCalls, 0);
  assert.equal(submitCalls, 0);
});

test('guest onboarding synchronization restarts the durability window after a persistence flap', async () => {
  const clock = createClock();
  let reads = 0;
  const controller = {
    readState: async () => {
      reads += 1;
      return reads === 4
        ? { ...persistedGuestState(), profileReady: false, localProfile: null, localPhone: null }
        : persistedGuestState();
    },
    fillFields: async () => false,
    submit: async () => false,
  };

  const result = await synchronizeGuestOnboarding(controller, {
    timeoutMs: 5_000,
    intervalMs: 100,
    durabilityWindowMs: 500,
    ...clock,
  });

  assert.equal(result.outcome, 'already-complete');
  assert.ok(reads >= 10, 'the transient loss reset the continuous durability window');
  assert.ok(clock.elapsed() >= 800);
});

test('guest profile durability is certified by reading it after a simulated process restart', async () => {
  const clock = createClock();
  let volatileProfile = persistedGuestState();
  let diskProfile = null;
  let restarts = 0;
  const originalSleep = clock.sleep;
  const options = {
    timeoutMs: 5_000,
    intervalMs: 100,
    durabilityWindowMs: 500,
    now: clock.now,
    sleep: async (ms) => {
      await originalSleep(ms);
      if (clock.elapsed() >= 500) diskProfile = persistedGuestState();
    },
  };
  const controller = {
    readState: async () => volatileProfile,
    fillFields: async () => false,
    submit: async () => false,
    restart: async () => {
      restarts += 1;
      volatileProfile = diskProfile;
      return 'restarted';
    },
  };

  await synchronizeGuestOnboarding(controller, options);
  const result = await certifyGuestProfileAcrossRestart(controller, options);

  assert.equal(restarts, 1);
  assert.equal(result.restartResult, 'restarted');
  assert.equal(expectedGuestProfileIsStable(result.beforeRestart), true);
  assert.equal(expectedGuestProfileIsStable(result.afterRestart), true);
});

test('guest profile durability certification fails closed when restart loses the profile', async () => {
  const clock = createClock();
  let state = persistedGuestState();
  const controller = {
    readState: async () => state,
    restart: async () => {
      state = {
        ...persistedGuestState(),
        profileReady: false,
        localProfile: null,
        localPhone: null,
      };
    },
  };

  await assert.rejects(
    certifyGuestProfileAcrossRestart(controller, {
      timeoutMs: 500,
      intervalMs: 100,
      ...clock,
    }),
    /guest profile after process restart timed out/,
  );
});

test('guest profile acceptance rejects every partially matching or stale identity state', () => {
  const valid = persistedGuestState();
  const invalidStates = [
    { ...valid, dialogVisible: true },
    { ...valid, profileReady: false },
    { ...valid, accountScope: 'authenticated' },
    { ...valid, localPhone: '0500000000' },
    { ...valid, localProfile: '{not-json' },
    { ...valid, localProfile: JSON.stringify({ displayName: 'Wrong', phoneNumber: '0501234567' }) },
    { ...valid, localProfile: JSON.stringify({ displayName: 'Android Smoke', phoneNumber: '0500000000' }) },
  ];

  assert.equal(expectedGuestProfileIsStable(valid), true);
  for (const state of invalidStates) assert.equal(expectedGuestProfileIsStable(state), false);
});
