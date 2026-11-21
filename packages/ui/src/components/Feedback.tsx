export function Loading() {
  return (
    <p className="pp-muted" role="status">
      Loading…
    </p>
  );
}

export function ErrorMessage({ message }: { readonly message: string | null }) {
  if (message === null) {
    return null;
  }

  return (
    <p className="pp-error" role="alert">
      {message}
    </p>
  );
}

export function Avatar({ name, url }: { readonly name: string; readonly url: string | null }) {
  return url === null ? (
    <span className="pp-avatar pp-avatar-initial" aria-hidden="true">
      {name.slice(0, 1).toUpperCase()}
    </span>
  ) : (
    <img className="pp-avatar" src={url} alt="" />
  );
}
