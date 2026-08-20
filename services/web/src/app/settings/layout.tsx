export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6" data-pw="page-settings">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight" data-pw="settings-heading">
          Settings
        </h2>
        <p className="text-sm text-muted-foreground">Your control-plane account.</p>
      </div>
      {children}
    </div>
  );
}
