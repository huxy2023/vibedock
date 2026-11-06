export type UserRole = 'admin' | 'user' | 'member';
export type ViewTab = 'catalog' | 'deploy' | 'assistant' | 'users';
export type CatalogLayout = 'cards' | 'table';

export interface User {
  id?: string;
  username: string;
  displayName?: string;
  role: UserRole;
  createdAt?: string;
}

export interface ProjectRoute {
  label: string;
  url: string;
}

export interface ProjectComponent {
  id: string;
  name: string;
  kind: 'static' | 'service' | 'worker';
  port: number | null;
  status: string;
  entryUrl: string;
  deployTarget: string;
  summary: string;
  runtimeCommand?: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  category: string;
  owner: string;
  status: string;
  updatedAt: string;
  domain: string;
  entryUrl: string;
  summary: string;
  tags: string[];
  routes: ProjectRoute[];
  components: ProjectComponent[];
  caddyConfig?: string;
  healthState?: 'online' | 'offline' | 'checking';
}

export interface DatabaseCatalogEntry {
  type: 'postgresql' | 'mysql' | 'mongodb' | 'redis';
  name: string;
  host: string;
  port: number;
  container: string;
  status: string;
  summary: string;
}

export interface UsedPortRecord {
  port: number;
  projectId: string;
  projectName: string;
  componentId: string;
  componentName: string;
  online: boolean;
}

export interface ProvisionedProjectDbSummary {
  project: string;
  updatedAt: string;
  types: string[];
}

export interface CatalogResponse {
  environment: {
    name: string;
    host: string;
    domainSuffix: string;
    sshPort?: number;
    deployUser?: string;
    skillUrl?: string;
    skillCommand?: string;
    allocatedPortRange?: string;
  };
  summary: {
    projectCount: number;
    serviceCount: number;
    staticCount: number;
    allocatedPorts: number[];
    nextSuggestedPort: number;
  };
  usedPorts?: UsedPortRecord[];
  provisionedProjects?: Array<string | ProvisionedProjectDbSummary>;
  categories: string[];
  databases: DatabaseCatalogEntry[];
  projects: ProjectRecord[];
}

export interface PendingAction {
  id: string;
  type: string;
  targetId: string;
  title: string;
  summary: string;
  risk: string;
  status: 'pending' | 'executed' | 'failed' | 'cancelled';
  commandPreview?: string;
  result?: {
    ok?: boolean;
    message?: string;
    error?: string;
  } | null;
}

export interface ChatTraceStep {
  type: string;
  title?: string;
  summary?: string;
  status?: string;
}

export interface ChatMessage {
  id?: string | number;
  role: 'user' | 'assistant';
  content: string;
  mode?: string;
  provider?: string;
  model?: string;
  trace?: ChatTraceStep[];
  pendingActions?: PendingAction[];
  suggestions?: string[];
}
