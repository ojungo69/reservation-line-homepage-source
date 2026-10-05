import { Link } from "react-router";

export default function NotFoundPage() {
  return (
    <div className="flex h-screen items-center justify-center">
      <div className="text-center">
        <h1 className="text-4xl font-bold">404</h1>
        <p className="mt-2 text-muted-foreground">ページが見つかりません</p>
        <Link to="/" className="mt-4 inline-flex min-h-11 items-center text-sm text-primary underline">
          スケジュールに戻る
        </Link>
      </div>
    </div>
  );
}
