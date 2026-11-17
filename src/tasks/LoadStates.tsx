// What the Tasks panel shows while a read is under way or after one failed, shared by Today and
// each list: skeleton rows in the shape of task rows, and the error with Try again.
import { Button } from "../components/ui/Button";
import { Skeleton } from "../components/ui/Skeleton";

/** A read that failed: why, and a way to run it again, above whatever the last good read left. */
export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="tasks-access">
      <p role="alert">Couldn't read tasks: {message}</p>
      <Button size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

/** Two task rows' worth of skeleton, until the tasks arrive. */
export function SkeletonRows() {
  return [0, 1].map((i) => (
    <div key={i} className="task-row" aria-hidden="true">
      <Skeleton shape="circle" className="task-row__skeleton-check" />
      <Skeleton width={`${60 - i * 20}%`} />
    </div>
  ));
}
