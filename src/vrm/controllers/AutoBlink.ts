import type { VRMExpressionManager } from "@pixiv/three-vrm";

/**
 * Periodic blinking.
 *
 * Derived from pixiv's ChatVRM (MIT) — see THIRD_PARTY_NOTICES.md. The one
 * change from the original: the open interval is jittered rather than a flat
 * 5 seconds, because a perfectly periodic blink is one of those details that
 * reads as uncanny without the viewer being able to say why.
 */

const BLINK_CLOSE_SEC = 0.12;
const BLINK_OPEN_MIN_SEC = 2.5;
const BLINK_OPEN_MAX_SEC = 6.5;

export class AutoBlink {
  private expressionManager: VRMExpressionManager;
  private remainingTime = 0;
  private isOpen = true;
  private enabled = true;

  constructor(expressionManager: VRMExpressionManager) {
    this.expressionManager = expressionManager;
  }

  /**
   * Enable or disable blinking.
   *
   * @returns Seconds until the eyes are open again. Applying an emotion while
   * the eyes are shut looks wrong, so callers wait this out first.
   */
  setEnabled(enabled: boolean): number {
    this.enabled = enabled;
    return this.isOpen ? 0 : this.remainingTime;
  }

  update(delta: number): void {
    if (this.remainingTime > 0) {
      this.remainingTime -= delta;
      return;
    }
    if (this.isOpen && this.enabled) {
      this.close();
      return;
    }
    this.open();
  }

  private close(): void {
    this.isOpen = false;
    this.remainingTime = BLINK_CLOSE_SEC;
    this.expressionManager.setValue("blink", 1);
  }

  private open(): void {
    this.isOpen = true;
    this.remainingTime =
      BLINK_OPEN_MIN_SEC + Math.random() * (BLINK_OPEN_MAX_SEC - BLINK_OPEN_MIN_SEC);
    this.expressionManager.setValue("blink", 0);
  }
}
