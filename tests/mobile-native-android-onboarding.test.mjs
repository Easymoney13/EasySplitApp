import test from 'node:test';
import assert from 'node:assert/strict';
import { synchronizeGuestOnboarding } from '../.github/validation/native-android-onboarding.mjs';

function createClock() {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms) => {
      current += ms;
    },
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
});

test('guest onboarding synchronization leaves an already-persisted profile untouched', async () => {
  let fillCalls = 0;
  let submitCalls = 0;
  const controller = {
    readState: async () => ({
      dialogVisible: false,
      inputValues: [],
      submitEnabled: false,
      profileReady: true,
    }),
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
  });

  assert.equal(result.outcome, 'already-complete');
  assert.equal(fillCalls, 0);
  assert.equal(submitCalls, 0);
});
