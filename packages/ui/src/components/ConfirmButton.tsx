import { useState } from 'react';

export interface ConfirmButtonProps {
  /** The first button, e.g. "Skip ticket". */
  readonly label: string;
  /** The confirming button, e.g. "Yes, skip ticket". */
  readonly confirmLabel: string;
  /** The button that backs out, e.g. "Keep ticket". */
  readonly cancelLabel: string;
  /** Said while confirming, so the consequence is clear before it happens. */
  readonly warning?: string;
  readonly disabled?: boolean;
  readonly onConfirm: () => void;
}

/**
 * Two-step confirmation inline for destructive actions: browser dialogs are not available inside
 * the Forge iframe.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  cancelLabel,
  warning,
  disabled = false,
  onConfirm,
}: ConfirmButtonProps) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        type="button"
        className="pp-button"
        disabled={disabled}
        onClick={() => {
          setConfirming(true);
        }}
      >
        {label}
      </button>
    );
  }

  return (
    <span className="pp-row" role="group" aria-label={label}>
      {warning !== undefined && <span className="pp-muted">{warning}</span>}
      <button
        type="button"
        className="pp-button pp-button-danger"
        disabled={disabled}
        onClick={() => {
          setConfirming(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </button>
      <button
        type="button"
        className="pp-button"
        onClick={() => {
          setConfirming(false);
        }}
      >
        {cancelLabel}
      </button>
    </span>
  );
}
