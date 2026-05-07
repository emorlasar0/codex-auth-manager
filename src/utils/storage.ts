import { invoke } from '@tauri-apps/api/core';
import type { AccountsStore, StoredAccount, CodexAuthConfig, AppConfig, AccountInfo } from '../types';
import { parseAccountInfo, generateId } from './jwt';

const DEFAULT_CONFIG: AppConfig = {
  autoRefreshInterval: 30, // 30分钟
  codexPath: 'codex',
  closeBehavior: 'ask',
  theme: 'dark',
  hasInitialized: false,
  proxyEnabled: false,
  proxyUrl: 'http://127.0.0.1:7890',
  autoRestartCodexOnSwitch: false,
  skipSwitchRestartConfirm: false,
};

const DEFAULT_STORE: AccountsStore = {
  version: '1.0.0',
  accounts: [],
  config: DEFAULT_CONFIG,
};

type LegacyStoredAccount = StoredAccount & { authConfig?: CodexAuthConfig };

export type AddAccountOptions = {
  allowMissingIdentity?: boolean;
};

type AccountIdentity = {
  accountId: string | null;
  userId: string | null;
  email: string | null;
};

type AccountWorkspaceMetadata = {
  workspaceName?: string | null;
  accountUserId?: string | null;
  accountStructure?: AccountInfo['accountStructure'];
  planType?: AccountInfo['planType'] | null;
};

type AccountBackupEntry = {
  alias?: string;
  authConfig: CodexAuthConfig;
};

type ZipEntry = {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  dataOffset: number;
};

type RawCredentialFile = Partial<{
  type: string;
  email: string;
  auth_mode: string;
  OPENAI_API_KEY: string | null;
  id_token: string;
  access_token: string;
  refresh_token: string;
  account_id: string;
  last_refresh: string;
  tokens: Partial<CodexAuthConfig['tokens']>;
}>;

type AccountsBackupFile = {
  format: 'codex-manager-backup';
  version: '1.0.0';
  exportedAt: string;
  accounts: AccountBackupEntry[];
};

const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_MAX_COMMENT_LENGTH = 0xffff;
const ZIP_MAX_JSON_ENTRIES = 500;
const ZIP_MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;

function normalizePlanType(
  value: string | null | undefined
): AccountInfo['planType'] | null {
  switch (value) {
    case 'free':
    case 'plus':
    case 'pro':
    case 'team':
      return value;
    default:
      return null;
  }
}

function normalizeId(value?: string | null): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeEmail(value?: string | null): string | null {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase() === 'unknown') return null;
  if (!trimmed.includes('@')) return null;
  return trimmed.toLowerCase();
}

function takeNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function hasValidTokens(authConfig: Partial<CodexAuthConfig>): authConfig is CodexAuthConfig {
  const tokens = authConfig.tokens;
  return Boolean(
    typeof authConfig.OPENAI_API_KEY !== 'undefined' &&
    typeof authConfig.last_refresh === 'string' &&
    typeof tokens?.id_token === 'string' &&
    tokens.id_token.trim() &&
    typeof tokens.access_token === 'string' &&
    tokens.access_token.trim() &&
    typeof tokens.refresh_token === 'string' &&
    tokens.refresh_token.trim() &&
    typeof tokens.account_id === 'string' &&
    tokens.account_id.trim()
  );
}

function getAliasFromZipEntryName(entryName: string): string | undefined {
  const fileName = entryName.split('/').pop()?.replace(/\.json$/i, '').trim();
  return fileName || undefined;
}

function normalizeCredentialFile(
  rawValue: unknown,
  entryName: string
): AccountBackupEntry {
  if (!rawValue || typeof rawValue !== 'object') {
    throw new Error(`${entryName} \u4e0d\u662f\u6709\u6548\u7684\u51ed\u8bc1 JSON`);
  }

  const raw = rawValue as RawCredentialFile;
  const nestedAuthConfig: Partial<CodexAuthConfig> = {
    auth_mode: raw.auth_mode,
    OPENAI_API_KEY: raw.OPENAI_API_KEY ?? null,
    tokens: {
      id_token: raw.tokens?.id_token ?? '',
      access_token: raw.tokens?.access_token ?? '',
      refresh_token: raw.tokens?.refresh_token ?? '',
      account_id: raw.tokens?.account_id ?? '',
    },
    last_refresh: raw.last_refresh ?? new Date().toISOString(),
  };

  if (hasValidTokens(nestedAuthConfig)) {
    return {
      alias: normalizeEmail(raw.email) ?? getAliasFromZipEntryName(entryName),
      authConfig: nestedAuthConfig,
    };
  }

  const flatAuthConfig: Partial<CodexAuthConfig> = {
    auth_mode: raw.auth_mode,
    OPENAI_API_KEY: raw.OPENAI_API_KEY ?? null,
    tokens: {
      id_token: takeNonEmptyString(raw.id_token) ?? '',
      access_token: takeNonEmptyString(raw.access_token) ?? '',
      refresh_token: takeNonEmptyString(raw.refresh_token) ?? '',
      account_id: takeNonEmptyString(raw.account_id) ?? '',
    },
    last_refresh: raw.last_refresh ?? new Date().toISOString(),
  };

  if (!hasValidTokens(flatAuthConfig)) {
    throw new Error(`${entryName} \u7f3a\u5c11\u5b8c\u6574\u7684 token \u5b57\u6bb5`);
  }

  return {
    alias: normalizeEmail(raw.email) ?? getAliasFromZipEntryName(entryName),
    authConfig: flatAuthConfig,
  };
}

export function normalizeCredentialJson(
  content: string,
  entryName = 'auth.json'
): AccountBackupEntry {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new Error('JSON 格式无效，请检查输入');
  }

  return normalizeCredentialFile(raw, entryName);
}

function getUint16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function getUint32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function findEndOfCentralDirectory(view: DataView): number {
  const minOffset = Math.max(0, view.byteLength - ZIP_MAX_COMMENT_LENGTH - 22);
  for (let offset = view.byteLength - 22; offset >= minOffset; offset -= 1) {
    if (getUint32(view, offset) === ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return offset;
    }
  }
  throw new Error('\u65e0\u6548\u7684 ZIP \u6587\u4ef6\uff1a\u672a\u627e\u5230\u4e2d\u592e\u76ee\u5f55');
}

function parseZipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEndOfCentralDirectory(view);
  const entryCount = getUint16(view, eocdOffset + 10);
  let offset = getUint32(view, eocdOffset + 16);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > view.byteLength || getUint32(view, offset) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error('\u65e0\u6548\u7684 ZIP \u6587\u4ef6\uff1a\u4e2d\u592e\u76ee\u5f55\u635f\u574f');
    }

    const compressionMethod = getUint16(view, offset + 10);
    const compressedSize = getUint32(view, offset + 20);
    const uncompressedSize = getUint32(view, offset + 24);
    const fileNameLength = getUint16(view, offset + 28);
    const extraLength = getUint16(view, offset + 30);
    const commentLength = getUint16(view, offset + 32);
    const localHeaderOffset = getUint32(view, offset + 42);
    const fileNameStart = offset + 46;
    const fileNameEnd = fileNameStart + fileNameLength;
    const name = decoder.decode(bytes.subarray(fileNameStart, fileNameEnd));

    if (localHeaderOffset + 30 > view.byteLength || getUint32(view, localHeaderOffset) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) {
      throw new Error(`\u65e0\u6548\u7684 ZIP \u6587\u4ef6\uff1a${name} \u672c\u5730\u6587\u4ef6\u5934\u635f\u574f`);
    }

    const localNameLength = getUint16(view, localHeaderOffset + 26);
    const localExtraLength = getUint16(view, localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;

    entries.push({
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      dataOffset,
    });

    offset = fileNameEnd + extraLength + commentLength;
  }

  return entries;
}

async function inflateZipEntry(entry: ZipEntry, bytes: Uint8Array): Promise<string> {
  if (entry.uncompressedSize > ZIP_MAX_UNCOMPRESSED_BYTES) {
    throw new Error(`${entry.name} \u8fc7\u5927\uff0c\u5df2\u62d2\u7edd\u5bfc\u5165`);
  }

  const compressedData = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  if (entry.compressionMethod === 0) {
    return new TextDecoder().decode(compressedData);
  }

  if (entry.compressionMethod !== 8) {
    throw new Error(`${entry.name} \u4f7f\u7528\u4e86\u4e0d\u652f\u6301\u7684 ZIP \u538b\u7f29\u65b9\u5f0f`);
  }

  if (typeof DecompressionStream === 'undefined') {
    throw new Error('\u5f53\u524d WebView \u4e0d\u652f\u6301 ZIP \u89e3\u538b');
  }

  const compressedBuffer = new ArrayBuffer(compressedData.byteLength);
  new Uint8Array(compressedBuffer).set(compressedData);
  const stream = new Blob([compressedBuffer]).stream().pipeThrough(
    new DecompressionStream('deflate-raw')
  );
  const decompressed = await new Response(stream).arrayBuffer();
  return new TextDecoder().decode(decompressed);
}

async function parseCredentialZip(bytes: Uint8Array): Promise<AccountsBackupFile> {
  const jsonEntries = parseZipEntries(bytes).filter(
    (entry) => !entry.name.endsWith('/') && entry.name.toLowerCase().endsWith('.json')
  );

  if (jsonEntries.length === 0) {
    throw new Error('ZIP \u4e2d\u672a\u627e\u5230\u51ed\u8bc1 JSON \u6587\u4ef6');
  }

  if (jsonEntries.length > ZIP_MAX_JSON_ENTRIES) {
    throw new Error('ZIP \u4e2d\u7684\u51ed\u8bc1 JSON \u6587\u4ef6\u8fc7\u591a\uff0c\u5df2\u62d2\u7edd\u5bfc\u5165');
  }

  const accounts: AccountBackupEntry[] = [];
  for (const entry of jsonEntries) {
    const content = await inflateZipEntry(entry, bytes);
    const raw = JSON.parse(content) as unknown;
    accounts.push(normalizeCredentialFile(raw, entry.name));
  }

  return {
    format: 'codex-manager-backup',
    version: '1.0.0',
    exportedAt: new Date().toISOString(),
    accounts,
  };
}

function buildIdentityFromAccountInfo(accountInfo: AccountInfo): AccountIdentity {
  return {
    accountId: normalizeId(accountInfo.accountId),
    userId: normalizeId(accountInfo.userId),
    email: normalizeEmail(accountInfo.email),
  };
}

function buildIdentityFromAuthConfig(authConfig: CodexAuthConfig): AccountIdentity {
  let accountInfo: AccountInfo | null = null;
  try {
    accountInfo = parseAccountInfo(authConfig);
  } catch (error) {
    console.log('Failed to parse auth token for identity:', error);
  }

  return {
    accountId: normalizeId(accountInfo?.accountId ?? authConfig.tokens?.account_id),
    userId: normalizeId(accountInfo?.userId),
    email: normalizeEmail(accountInfo?.email),
  };
}

function areAuthConfigsEquivalent(a: CodexAuthConfig, b: CodexAuthConfig): boolean {
  return (
    (a.OPENAI_API_KEY ?? null) === (b.OPENAI_API_KEY ?? null) &&
    (a.last_refresh ?? '') === (b.last_refresh ?? '') &&
    (a.tokens?.id_token ?? '') === (b.tokens?.id_token ?? '') &&
    (a.tokens?.access_token ?? '') === (b.tokens?.access_token ?? '') &&
    (a.tokens?.refresh_token ?? '') === (b.tokens?.refresh_token ?? '') &&
    (a.tokens?.account_id ?? '') === (b.tokens?.account_id ?? '')
  );
}

function isEmptyIdentity(identity: AccountIdentity): boolean {
  return !identity.accountId && !identity.userId && !identity.email;
}

function isIdentityInsufficient(identity: AccountIdentity): boolean {
  return !identity.userId && !identity.email;
}

function getMatchRank(a: AccountIdentity, b: AccountIdentity): number {
  // 当两者都有 accountId 且不同时，属于不同工作空间（如个人 vs Team），
  // 即使 email/userId 相同也不应视为同一账号
  if (a.accountId && b.accountId && a.accountId !== b.accountId) return 0;

  if (a.accountId && b.accountId && a.userId && b.userId) {
    if (a.accountId === b.accountId && a.userId === b.userId) return 5;
  }
  if (a.accountId && b.accountId && a.email && b.email) {
    if (a.accountId === b.accountId && a.email === b.email) return 4;
  }
  if (a.userId && b.userId && a.userId === b.userId) return 3;
  if (a.email && b.email && a.email === b.email) return 2;
  if (a.accountId && b.accountId && a.accountId === b.accountId) return 1;
  return 0;
}

function findBestMatch(
  accounts: StoredAccount[],
  identity: AccountIdentity
): { index: number; rank: number; count: number } {
  let bestIndex = -1;
  let bestRank = 0;
  let bestUpdatedAt = '';
  let bestCount = 0;

  accounts.forEach((account, index) => {
    const rank = getMatchRank(buildIdentityFromAccountInfo(account.accountInfo), identity);
    if (rank === 0) return;
    if (rank > bestRank) {
      bestRank = rank;
      bestIndex = index;
      bestUpdatedAt = account.updatedAt;
      bestCount = 1;
      return;
    }
    if (rank === bestRank) {
      bestCount += 1;
      if (!bestUpdatedAt || account.updatedAt > bestUpdatedAt) {
        bestIndex = index;
        bestUpdatedAt = account.updatedAt;
      }
    }
  });

  return { index: bestIndex, rank: bestRank, count: bestCount };
}

const MISSING_IDENTITY_ERROR = 'missing_account_identity';

function createMissingIdentityError(): Error {
  const error = new Error(MISSING_IDENTITY_ERROR);
  error.name = 'MissingAccountIdentity';
  return error;
}

export function isMissingIdentityError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message === MISSING_IDENTITY_ERROR || error.name === 'MissingAccountIdentity';
}

function buildFallbackAccountInfo(identity: AccountIdentity): AccountInfo {
  return {
    email: identity.email ?? 'Unknown',
    planType: 'free',
    accountId: identity.accountId ?? '',
    userId: identity.userId ?? '',
    accountUserId: undefined,
    accountStructure: undefined,
    workspaceName: undefined,
    subscriptionActiveUntil: undefined,
    organizations: [],
  };
}

async function saveAccountAuth(accountId: string, authConfig: CodexAuthConfig): Promise<void> {
  await invoke('save_account_auth', {
    accountId,
    authConfig: JSON.stringify(authConfig),
  });
}

async function loadAccountAuth(accountId: string): Promise<CodexAuthConfig> {
  const authJson = await invoke<string>('read_account_auth', { accountId });
  return JSON.parse(authJson) as CodexAuthConfig;
}

async function deleteAccountAuth(accountId: string): Promise<void> {
  await invoke('delete_account_auth', { accountId });
}

function parseAccountsBackup(data: string): AccountsBackupFile {
  let parsed: Partial<AccountsBackupFile>;
  try {
    parsed = JSON.parse(data) as Partial<AccountsBackupFile>;
  } catch {
    throw new Error('备份文件不是有效的 JSON');
  }

  if (parsed.format !== 'codex-manager-backup') {
    throw new Error('无效的备份格式');
  }

  if (!Array.isArray(parsed.accounts)) {
    throw new Error('备份文件缺少账号列表');
  }

  parsed.accounts.forEach((account, index) => {
    const tokens = account?.authConfig?.tokens;
    const hasValidTokens =
      typeof tokens?.id_token === 'string' &&
      tokens.id_token.trim() &&
      typeof tokens.access_token === 'string' &&
      tokens.access_token.trim() &&
      typeof tokens.refresh_token === 'string' &&
      tokens.refresh_token.trim() &&
      typeof tokens.account_id === 'string' &&
      tokens.account_id.trim();

    if (!hasValidTokens) {
      throw new Error(`备份文件中的第 ${index + 1} 个账号缺少完整凭证`);
    }
  });

  return {
    format: 'codex-manager-backup',
    version: '1.0.0',
    exportedAt: parsed.exportedAt || new Date().toISOString(),
    accounts: parsed.accounts,
  };
}
function mergeWorkspaceMetadata(
  accountInfo: AccountInfo,
  metadata: AccountWorkspaceMetadata | null | undefined
): AccountInfo {
  if (!metadata) return accountInfo;

  const currentPlanType = normalizePlanType(accountInfo.planType) ?? 'free';
  const metadataPlanType = normalizePlanType(metadata.planType);
  const accountStructure = metadata.accountStructure ?? accountInfo.accountStructure;

  let mergedPlanType = currentPlanType;
  if (metadataPlanType) {
    if (accountStructure === 'workspace') {
      mergedPlanType = metadataPlanType;
    } else if (currentPlanType === 'free' && metadataPlanType !== 'free') {
      mergedPlanType = metadataPlanType;
    }
  }

  return {
    ...accountInfo,
    accountUserId: metadata.accountUserId ?? accountInfo.accountUserId,
    accountStructure,
    workspaceName: metadata.workspaceName ?? accountInfo.workspaceName,
    planType: mergedPlanType,
  };
}

async function fetchWorkspaceMetadata(
  accountId: string,
  config: AppConfig
): Promise<AccountWorkspaceMetadata | null> {
  try {
    return await invoke<AccountWorkspaceMetadata | null>('get_wham_account_metadata', {
      accountId,
      proxyEnabled: config.proxyEnabled,
      proxyUrl: config.proxyUrl,
    });
  } catch (error) {
    console.log(`Failed to fetch workspace metadata for account ${accountId}:`, error);
    return null;
  }
}

function getActiveAccountId(accounts: StoredAccount[]): string | null {
  return accounts.find((account) => account.isActive)?.id ?? null;
}

async function saveStoreWithActiveAccount(accountId: string | null): Promise<AccountsStore> {
  const latestStore = await loadAccountsStore();
  let changed = false;

  const accounts = latestStore.accounts.map((account) => {
    const shouldBeActive = accountId ? account.id === accountId : false;
    if (account.isActive === shouldBeActive) {
      return account;
    }

    changed = true;
    return {
      ...account,
      isActive: shouldBeActive,
    };
  });

  if (!changed) {
    return latestStore;
  }

  const nextStore: AccountsStore = {
    ...latestStore,
    accounts,
  };
  await saveAccountsStore(nextStore);
  return nextStore;
}

/**
 * 加载账号存储数据
 */
export async function loadAccountsStore(): Promise<AccountsStore> {
  try {
    const data = await invoke<string>('load_accounts_store');
    const store = JSON.parse(data) as AccountsStore & { accounts?: LegacyStoredAccount[] };
    const accounts = store.accounts ?? [];
    let needsSave = false;

    const normalizedAccounts: StoredAccount[] = [];

    for (const account of accounts) {
      if (account.authConfig) {
        await saveAccountAuth(account.id, account.authConfig);
        needsSave = true;
      }
      const normalizedAccount = { ...account } as StoredAccount & { authConfig?: CodexAuthConfig };
      delete normalizedAccount.authConfig;
      normalizedAccounts.push(normalizedAccount);
    }

    const normalizedStore: AccountsStore = {
      ...DEFAULT_STORE,
      ...store,
      accounts: normalizedAccounts,
      config: { ...DEFAULT_CONFIG, ...store.config },
    };

    if (needsSave) {
      await saveAccountsStore(normalizedStore);
    }

    return normalizedStore;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Store file not found')) {
      console.log('No existing store found, using default:', error);
      return DEFAULT_STORE;
    }
    throw error;
  }
}

/**
 * 保存账号存储数据
 */
export async function saveAccountsStore(store: AccountsStore): Promise<void> {
  const data = JSON.stringify(store, null, 2);
  await invoke('save_accounts_store', { data });
}

export async function exportAccountsBackup(): Promise<string> {
  const store = await loadAccountsStore();

  const accounts = await Promise.all(
    store.accounts.map(async (account) => ({
      alias: account.alias || undefined,
      authConfig: await loadAccountAuth(account.id),
    }))
  );

  const backup: AccountsBackupFile = {
    format: 'codex-manager-backup',
    version: '1.0.0',
    exportedAt: new Date().toISOString(),
    accounts,
  };

  return JSON.stringify(backup, null, 2);
}

export async function importAccountsBackup(
  backupJson: string
): Promise<{ importedCount: number }> {
  const backup = parseAccountsBackup(backupJson);
  return importBackupAccounts(backup);
}

async function importBackupAccounts(
  backup: AccountsBackupFile
): Promise<{ importedCount: number }> {
  for (const account of backup.accounts) {
    await addAccount(account.authConfig, account.alias, { allowMissingIdentity: true });
  }

  return { importedCount: backup.accounts.length };
}

export async function importAccountsBackupFile(
  filePath: string
): Promise<{ importedCount: number }> {
  if (!filePath.toLowerCase().endsWith('.json')) {
    throw new Error('请选择 Codex Manager JSON 备份文件');
  }

  const backupJson = await invoke<string>('read_file_content', { filePath });
  return importAccountsBackup(backupJson);
}

export async function importAuthZipFile(
  filePath: string
): Promise<{ importedCount: number }> {
  if (!filePath.toLowerCase().endsWith('.zip')) {
    throw new Error('请选择包含 auth JSON 的 ZIP 压缩包');
  }

  const bytes = await invoke<number[]>('read_file_bytes', { filePath });
  const backup = await parseCredentialZip(new Uint8Array(bytes));
  return importBackupAccounts(backup);
}

export async function importAuthZipBytes(
  bytes: Uint8Array
): Promise<{ importedCount: number }> {
  const backup = await parseCredentialZip(bytes);
  return importBackupAccounts(backup);
}

/**
 * 添加新账号
 */
export async function addAccount(
  authConfig: CodexAuthConfig,
  alias?: string,
  options: AddAccountOptions = {}
): Promise<StoredAccount> {
  const store = await loadAccountsStore();

  let accountInfo: AccountInfo;
  try {
    accountInfo = parseAccountInfo(authConfig);
  } catch {
    const identity = buildIdentityFromAuthConfig(authConfig);
    if (!options.allowMissingIdentity) {
      throw createMissingIdentityError();
    }
    accountInfo = buildFallbackAccountInfo(identity);
  }

  const newIdentity = buildIdentityFromAccountInfo(accountInfo);
  if (isIdentityInsufficient(newIdentity) && !options.allowMissingIdentity) {
    throw createMissingIdentityError();
  }
  
  // 检查是否已存在
  const match = findBestMatch(store.accounts, newIdentity);
  const existingIndex = match.rank >= 2 ? match.index : -1;
  
  const now = new Date().toISOString();
  
  if (existingIndex >= 0) {
    const existingAccount = store.accounts[existingIndex];
    await saveAccountAuth(existingAccount.id, authConfig);
    const workspaceMetadata = await fetchWorkspaceMetadata(existingAccount.id, store.config);
    const latestStore = await loadAccountsStore();
    const latestIndex = latestStore.accounts.findIndex((account) => account.id === existingAccount.id);

    if (latestIndex >= 0) {
      const latestAccount = latestStore.accounts[latestIndex];
      const nextAccount: StoredAccount = {
        ...latestAccount,
        accountInfo: mergeWorkspaceMetadata(
          {
            ...latestAccount.accountInfo,
            ...accountInfo,
          },
          workspaceMetadata
        ),
        alias: alias || latestAccount.alias,
        updatedAt: now,
      };
      latestStore.accounts[latestIndex] = nextAccount;
      await saveAccountsStore(latestStore);
      return nextAccount;
    }

    const restoredAccount: StoredAccount = {
      ...existingAccount,
      accountInfo: mergeWorkspaceMetadata(
        {
          ...existingAccount.accountInfo,
          ...accountInfo,
        },
        workspaceMetadata
      ),
      alias: alias || existingAccount.alias,
      updatedAt: now,
    };
    latestStore.accounts.push(restoredAccount);
    await saveAccountsStore(latestStore);
    return restoredAccount;
  }
  
  // ?????
  // ???????????????????????
  let autoAlias = alias || accountInfo.email.split('@')[0];
  if (!alias) {
    const newEmail = normalizeEmail(accountInfo.email);
    const hasSameEmail = newEmail && store.accounts.some(
      (acc) => normalizeEmail(acc.accountInfo.email) === newEmail
    );
    if (hasSameEmail) {
      const planLabel = accountInfo.planType.charAt(0).toUpperCase() + accountInfo.planType.slice(1);
      autoAlias = `${autoAlias} (${planLabel})`;
    }
  }

  const newAccount: StoredAccount = {
    id: generateId(),
    alias: autoAlias,
    accountInfo,
    isActive: store.accounts.length === 0, // ?????????
    createdAt: now,
    updatedAt: now,
  };
  
  await saveAccountAuth(newAccount.id, authConfig);
  const workspaceMetadata = await fetchWorkspaceMetadata(newAccount.id, store.config);
  const latestStore = await loadAccountsStore();
  const latestMatch = findBestMatch(latestStore.accounts, newIdentity);

  if (latestMatch.rank >= 2 && latestMatch.index >= 0) {
    const latestAccount = latestStore.accounts[latestMatch.index];
    await saveAccountAuth(latestAccount.id, authConfig);
    if (latestAccount.id !== newAccount.id) {
      await deleteAccountAuth(newAccount.id).catch((error) => {
        console.log(`Failed to delete temporary auth for account ${newAccount.id}:`, error);
      });
    }

    const nextAccount: StoredAccount = {
      ...latestAccount,
      accountInfo: mergeWorkspaceMetadata(
        {
          ...latestAccount.accountInfo,
          ...accountInfo,
        },
        workspaceMetadata
      ),
      alias: alias || latestAccount.alias,
      updatedAt: now,
    };
    latestStore.accounts[latestMatch.index] = nextAccount;
    await saveAccountsStore(latestStore);
    return nextAccount;
  }

  const finalAccount: StoredAccount = {
    ...newAccount,
    accountInfo: mergeWorkspaceMetadata(newAccount.accountInfo, workspaceMetadata),
    isActive: latestStore.accounts.length === 0,
  };
  latestStore.accounts.push(finalAccount);
  await saveAccountsStore(latestStore);
  
  return finalAccount;
}

export async function refreshAccountsWorkspaceMetadata(config: AppConfig): Promise<StoredAccount[]> {
  const store = await loadAccountsStore();
  const accountInfoUpdates = new Map<string, AccountInfo>();

  await Promise.all(
    store.accounts.map(async (account) => {
      let baseAccountInfo = account.accountInfo;
      try {
        const authConfig = await loadAccountAuth(account.id);
        const parsedAccountInfo = parseAccountInfo(authConfig);
        baseAccountInfo = {
          ...account.accountInfo,
          ...parsedAccountInfo,
          accountStructure: account.accountInfo.accountStructure,
          workspaceName: account.accountInfo.workspaceName,
        };
      } catch (error) {
        console.log(`Failed to reload account info from auth for account ${account.id}:`, error);
      }

      const metadata = await fetchWorkspaceMetadata(account.id, config);
      const accountInfo = mergeWorkspaceMetadata(baseAccountInfo, metadata);

      if (JSON.stringify(accountInfo) !== JSON.stringify(account.accountInfo)) {
        accountInfoUpdates.set(account.id, accountInfo);
      }
    })
  );

  if (accountInfoUpdates.size === 0) {
    return store.accounts;
  }

  const latestStore = await loadAccountsStore();
  let changed = false;
  const updatedAccounts = latestStore.accounts.map((account) => {
    const nextAccountInfo = accountInfoUpdates.get(account.id);
    if (!nextAccountInfo) {
      return account;
    }

    if (JSON.stringify(nextAccountInfo) === JSON.stringify(account.accountInfo)) {
      return account;
    }

    changed = true;
    return {
      ...account,
      accountInfo: nextAccountInfo,
    };
  });

  if (!changed) {
    return latestStore.accounts;
  }

  const nextStore: AccountsStore = {
    ...latestStore,
    accounts: updatedAccounts,
  };
  await saveAccountsStore(nextStore);
  return nextStore.accounts;
}

/**
 * 删除账号
 */
export async function removeAccount(accountId: string): Promise<void> {
  const store = await loadAccountsStore();
  const removedAccount = store.accounts.find((acc) => acc.id === accountId);
  store.accounts = store.accounts.filter((acc) => acc.id !== accountId);

  if (
    removedAccount?.isActive &&
    store.accounts.length > 0 &&
    !store.accounts.some((account) => account.isActive)
  ) {
    store.accounts[0] = {
      ...store.accounts[0],
      isActive: true,
    };
  }

  await saveAccountsStore(store);
  await deleteAccountAuth(accountId);
}

/**
 * 更新账号用量信息
 */
export async function updateAccountUsage(
  accountId: string,
  usageInfo: StoredAccount['usageInfo']
): Promise<void> {
  const store = await loadAccountsStore();
  const account = store.accounts.find((acc) => acc.id === accountId);
  
  if (account) {
    account.usageInfo = usageInfo;
    account.updatedAt = new Date().toISOString();
    await saveAccountsStore(store);
  }
}

/**
 * 设置活动账号
 */
export async function setActiveAccount(accountId: string): Promise<void> {
  await saveStoreWithActiveAccount(accountId);
}

/**
 * 获取活动账号
 */
export async function getActiveAccount(): Promise<StoredAccount | null> {
  const store = await loadAccountsStore();
  return store.accounts.find((acc) => acc.isActive) || null;
}

/**
 * 切换到指定账号（写入.codex/auth.json）
 */
export async function switchToAccount(accountId: string): Promise<void> {
  await syncCurrentAccount();

  const store = await loadAccountsStore();
  const account = store.accounts.find((acc) => acc.id === accountId);

  if (!account) {
    throw new Error('Account not found');
  }

  const authConfig = await loadAccountAuth(accountId);

  // ???Tauri??????auth.json
  await invoke('write_codex_auth', {
    authConfig: JSON.stringify(authConfig),
  });

  // ??????????
  await setActiveAccount(accountId);
}

/**
 * 从文件导入账号
 */
export async function importAccountFromFile(
  filePath: string,
  options: AddAccountOptions = {}
): Promise<StoredAccount> {
  const content = await invoke<string>('read_file_content', { filePath });
  const { authConfig } = normalizeCredentialJson(
    content,
    filePath.split(/[\\/]/).pop() ?? 'auth.json'
  );
  return addAccount(authConfig, undefined, options);
}

/**
 * 更新应用配置
 */
export async function updateAppConfig(config: Partial<AppConfig>): Promise<void> {
  const store = await loadAccountsStore();
  store.config = { ...store.config, ...config };
  await saveAccountsStore(store);
}

/**
 * 读取当前 .codex/auth.json 的账号ID
 */
export async function getCurrentAuthAccountId(): Promise<string | null> {
  try {
    const authJson = await invoke<string>('read_codex_auth');
    const authConfig = JSON.parse(authJson) as CodexAuthConfig;

    const identity = buildIdentityFromAuthConfig(authConfig);
    return identity.accountId ?? null;
  } catch (error) {
    console.log('Failed to read current auth:', error);
    return null;
  }
}

/**
 * 同步当前登录账号状态
 * 读取 .codex/auth.json 并与系统中的账号比对，更新 isActive 状态
 * 如果 auth.json 不存在，则清除所有账号的 isActive 状态
 */
export async function syncCurrentAccount(): Promise<string | null> {
  let currentIdentity: AccountIdentity | null = null;
  let currentAuthConfig: CodexAuthConfig | null = null;
  try {
    const authJson = await invoke<string>('read_codex_auth');
    const authConfig = JSON.parse(authJson) as CodexAuthConfig;
    currentAuthConfig = authConfig;
    currentIdentity = buildIdentityFromAuthConfig(authConfig);
  } catch (error) {
    console.log('Failed to read current auth:', error);
  }

  const store = await loadAccountsStore();
  let matchedId: string | null = null;

  if (!currentIdentity || isEmptyIdentity(currentIdentity)) {
    await saveStoreWithActiveAccount(null);
    return null;
  }

  let bestRank = 0;
  let bestIndexes: number[] = [];

  store.accounts.forEach((acc, index) => {
    const rank = getMatchRank(buildIdentityFromAccountInfo(acc.accountInfo), currentIdentity);
    if (rank === 0) return;
    if (rank > bestRank) {
      bestRank = rank;
      bestIndexes = [index];
      return;
    }
    if (rank === bestRank) {
      bestIndexes.push(index);
    }
  });

  if (bestRank === 0 || bestIndexes.length === 0) {
    await saveStoreWithActiveAccount(null);
    return null;
  }

  let targetIndex = bestIndexes[0];
  const activeIndex = bestIndexes.find((index) => store.accounts[index].isActive);
  if (typeof activeIndex === 'number') {
    targetIndex = activeIndex;
  } else {
    targetIndex = bestIndexes.reduce((best, index) => {
      const bestTime = store.accounts[best].updatedAt;
      const currentTime = store.accounts[index].updatedAt;
      return currentTime > bestTime ? index : best;
    }, bestIndexes[0]);
  }

  matchedId = store.accounts[targetIndex]?.id ?? null;

  const persistedStore = await saveStoreWithActiveAccount(matchedId);
  matchedId = matchedId && persistedStore.accounts.some((account) => account.id === matchedId)
    ? matchedId
    : getActiveAccountId(persistedStore.accounts);

  if (matchedId && currentAuthConfig) {
    let shouldPersistCurrentAuth = false;

    try {
      const storedAuth = await loadAccountAuth(matchedId);
      shouldPersistCurrentAuth = !areAuthConfigsEquivalent(storedAuth, currentAuthConfig);
    } catch (error) {
      console.log(`Failed to read stored auth for account ${matchedId}:`, error);
      shouldPersistCurrentAuth = true;
    }

    if (shouldPersistCurrentAuth) {
      await saveAccountAuth(matchedId, currentAuthConfig);
    }
  }

  return matchedId;
}
