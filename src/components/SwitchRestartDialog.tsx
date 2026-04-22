import React, { useState } from 'react';

interface SwitchRestartDialogProps {
  isOpen: boolean;
  mode?: 'confirm' | 'progress';
  isSubmitting?: boolean;
  accountName?: string | null;
  onClose: () => void;
  onConfirm: (rememberChoice: boolean) => void;
}

function SwitchRestartDialogContent({
  mode = 'confirm',
  isSubmitting = false,
  accountName,
  onClose,
  onConfirm,
}: Omit<SwitchRestartDialogProps, 'isOpen'>) {
  const [rememberChoice, setRememberChoice] = useState(false);
  const isProgress = mode === 'progress' || isSubmitting;
  const targetText = accountName ? `“${accountName}”` : '目标账号';

  return (
    <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 animate-fade-in">
      <div className="bg-white rounded-2xl p-6 w-full max-w-lg mx-4 border border-[var(--dash-border)] shadow-[0_24px_60px_rgba(15,23,42,0.2)]">
        <div className="flex items-start gap-3 mb-5">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${
            isProgress ? 'bg-blue-50 text-blue-600' : 'bg-amber-50 text-amber-600'
          }`}>
            {isProgress ? (
              <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            )}
          </div>
          <div>
            <h2 className="text-base font-semibold text-[var(--dash-text-primary)]">
              {isProgress ? '正在切换账号并重启 Codex' : '切换账号并重启 Codex'}
            </h2>
            <div className="text-sm text-[var(--dash-text-secondary)] mt-2 space-y-2">
              {isProgress ? (
                <>
                  <p>正在切换到 {targetText}，并通过系统方式重新唤醒 Codex App。</p>
                  <p>窗口出现前可能会有几秒延迟，请不要重复切换，也不要手动关闭当前管理器窗口。</p>
                </>
              ) : (
                <>
                  <p>
                    当前切换会结束并重启 Codex 相关进程，包括 Codex App 与 PowerShell 中运行的 Codex。
                  </p>
                  <p>
                    如果当前有会话进行中，请先等待完成，或者在小工具中关闭“切换账号后自动重启 Codex”功能。
                  </p>
                </>
              )}
            </div>
          </div>
        </div>

        {isProgress ? (
          <div className="rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3">
            <div className="flex items-center gap-3 text-blue-700">
              <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <div>
                <p className="text-sm font-medium">正在切换账号并等待 Codex App 就绪</p>
                <p className="text-xs mt-1 opacity-80">如果系统通过应用别名唤醒 Codex，出现窗口前会有短暂等待。</p>
              </div>
            </div>
          </div>
        ) : (
          <>
            <label className="flex items-center gap-3 rounded-xl bg-slate-50 px-3 py-2 text-sm text-[var(--dash-text-secondary)]">
              <input
                type="checkbox"
                checked={rememberChoice}
                onChange={(event) => setRememberChoice(event.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-blue-500 focus:ring-blue-400"
              />
              <span>下次不再提示</span>
            </label>

            <div className="flex gap-2 mt-5 justify-end">
              <button
                type="button"
                onClick={onClose}
                disabled={isSubmitting}
                className="h-10 px-4 bg-slate-100 hover:bg-slate-200 text-[var(--dash-text-primary)] rounded-xl text-sm transition-colors disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => onConfirm(rememberChoice)}
                disabled={isSubmitting}
                className="h-10 px-4 bg-[var(--dash-accent)] hover:brightness-110 text-white rounded-xl text-sm font-medium transition-colors disabled:opacity-50"
              >
                确认重启
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export const SwitchRestartDialog: React.FC<SwitchRestartDialogProps> = ({
  isOpen,
  mode,
  isSubmitting,
  accountName,
  onClose,
  onConfirm,
}) => {
  if (!isOpen) return null;

  return (
    <SwitchRestartDialogContent
      mode={mode}
      isSubmitting={isSubmitting}
      accountName={accountName}
      onClose={onClose}
      onConfirm={onConfirm}
    />
  );
};

export default SwitchRestartDialog;
