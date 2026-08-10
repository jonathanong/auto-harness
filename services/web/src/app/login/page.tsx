import { Suspense } from "react";

import { LoginForm } from "../../components/login-form.tsx";

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center px-4 py-8" data-pw="page-login">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
