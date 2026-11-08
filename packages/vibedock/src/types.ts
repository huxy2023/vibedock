export type UserRole = 'admin' | 'member';
export type DatabaseEngine = 'postgresql' | 'mysql' | 'mongodb' | 'redis';

export interface AppError extends Error {
  status?: number;
  expose?: boolean;
}

export interface UserDto {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface VibeDockConfig {
  rootDir: string;
  configPath: string;
  brandName: string;
  portalTitle: string;
  skillName: string;
  serverHost: string;
  sshPort: number;
  deployUser: string;
  appPrefix: string;
  domainMode: 'nip' | 'letsencrypt' | 'custom';
  gateway?: 'caddy' | 'nginx' | 'none';
  primaryDomain: string;
  backupDomain: string;
  portalUrl: string;
  tls?: {
    certFile?: string;
    keyFile?: string;
  };
  portRange: {
    start: number;
    end: number;
  };
  paths: {
    dataDir: string;
    appsDir: string;
    caddyBin: string;
    caddyConfig: string;
    caddySitesDir: string;
    nginxBin?: string;
    nginxConfig?: string;
    nginxSitesDir?: string;
    dbSecretsDir: string;
    skillZipFile: string;
  };
  databases: {
    mode: 'docker' | 'external' | 'mixed';
    composeFile: string;
    enabled: string[];
  };
  auth: {
    defaultAdminUser: string;
    defaultAdminDisplayName: string;
    defaultAdminPassword: string;
    defaultMemberPassword: string;
    defaultInviteCode: string;
  };
}

export interface CatalogListener {
  id: string;
  name?: string;
  protocol: 'http' | 'https' | 'websocket' | 'tcp';
  scope?: 'local' | 'remote';
  host: string;
  port: number;
  online?: boolean;
  checkedAt?: string;
}

export interface CatalogComponent {
  id: string;
  name: string;
  role?: string;
  type?: 'static' | 'service' | 'backend' | 'web';
  runtime?: string;
  staticRoot?: string;
  processManager?: string;
  processName?: string;
  deploymentProcess?: string;
  listeners: CatalogListener[];
  online?: boolean;
}

export interface IngressRule {
  id: string;
  name?: string;
  match: {
    scheme?: 'http' | 'https';
    protocol: 'http' | 'websocket';
    hosts: string[];
    paths: string[];
  };
  tls?: {
    certificateFile?: string;
    keyFile?: string;
    managed?: boolean;
  };
  target: {
    component: string;
    listener?: string;
  };
}

export interface CatalogProject {
  id: string;
  name: string;
  shortName?: string;
  owner?: string;
  color?: string;
  description?: string;
  aliases?: string[];
  tags?: string[];
  projectPath?: string;
  configPath?: string;
  status?: 'online' | 'degraded';
  caddyConfig?: string;
  components: CatalogComponent[];
  ingressRules: IngressRule[];
  commands?: Array<{ label: string; command: string }>;
}

export interface CatalogData {
  environment?: {
    name?: string;
    brandName?: string;
    skillName?: string;
    address?: string;
    domainSuffix?: string;
    backupDomainSuffix?: string;
    gatewayPort?: number;
    gatewayTlsPort?: number;
  };
  projects: CatalogProject[];
  generatedAt?: string;
  summary?: {
    projects: number;
    components: number;
    listeners: number;
    onlineListeners: number;
    staticComponents: number;
    ingressRules: number;
    portConflicts: number;
    onlineDatabases: number;
    totalDatabases: number;
  };
  dx?: {
    skillName?: string;
    deployUser?: string;
    appPrefix?: string;
    skillPackageUrl?: string;
    portPool: {
      range: string;
      minPort: number;
      maxPort: number;
      nextAvailablePort: number;
      usedPorts: Array<{
        port: number;
        projectId: string;
        projectName: string;
        componentId: string;
        componentName: string;
        online: boolean;
      }>;
    };
    databases: Array<{
      id: string;
      name: string;
      port: number;
      host: string;
      envKey: string;
      isolation: string;
      exampleUrl: string;
      online: boolean;
      checkedAt?: string;
    }>;
    provisionedProjects: string[];
  };
}

export type ActionRisk = 'read' | 'sensitive' | 'change';
export type ActionKind = 'diagnose' | 'status' | 'logs' | 'restart' | 'health';

export interface ActionMetadata {
  id: string;
  projectId?: string;
  componentId?: string;
  label: string;
  description: string;
  command: string;
  kind: ActionKind;
  risk: ActionRisk;
  requiresReason?: boolean;
}

export interface ActionDefinition extends ActionMetadata {
  executor:
    | { type: 'diagnose'; projectId: string }
    | { type: 'exec'; binary: 'pm2' | 'deployPm2' | 'systemctl' | 'journalctl' | 'caddy'; args: string[]; allowNonZero?: boolean };
}

export interface PublishComponentSpec {
  id?: string;
  name?: string;
  kind: 'static' | 'service' | 'external';
  runtime?: 'node' | 'python' | 'go' | 'external' | string;
  root?: string;
  routing?: 'spa' | 'mpa';
  port?: number;
  upstream?: string;
  entry?: string;
}

export interface PublishRouteSpec {
  component: string;
  host?: 'main' | 'sub';
  subdomain?: string;
  path: string;
  stripPrefix?: boolean;
  websocket?: boolean;
}

export interface PublishManifest {
  id: string;
  name?: string;
  title?: string;
  owner: string;
  description: string;
  tags?: string[];
  components: PublishComponentSpec[];
  routes?: PublishRouteSpec[];
}
