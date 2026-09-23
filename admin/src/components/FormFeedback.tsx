import { CheckCircle2, CircleAlert } from 'lucide-react';

export type Feedback = { kind: 'success' | 'error'; message: string } | null;

// Text + icon (never color alone). Errors are announced assertively,
// successes politely.
export function FormFeedback({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null;
  if (feedback.kind === 'error') {
    return (
      <p className="error-banner" role="alert">
        <CircleAlert size={16} aria-hidden="true" /> {feedback.message}
      </p>
    );
  }
  return (
    <p className="success-banner" role="status">
      <CheckCircle2 size={16} aria-hidden="true" /> {feedback.message}
    </p>
  );
}
