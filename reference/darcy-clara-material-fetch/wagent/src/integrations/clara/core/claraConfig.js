import fs from 'fs';
import path from 'path';

export const DEFAULT_CLARA_API_URL = 'http://127.0.0.1:8010';
export const DEFAULT_CLARA_LIMIT = 10000;
export const DEFAULT_CLARA_PARQUET_PATH = 'C:/server/clara-api/latest_merged_data.parquet';

export const parseEnvFile = (filePath) => {
    if (!fs.existsSync(filePath)) return {};
    return Object.fromEntries(
        fs.readFileSync(filePath, 'utf8')
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('#') && line.includes('='))
            .map(line => {
                const [key, ...rest] = line.split('=');
                return [key.trim(), rest.join('=').trim().replace(/^["']|["']$/g, '')];
            })
    );
};

export function resolveClaraPaths(projectRoot = process.cwd()) {
    const root = path.resolve(projectRoot);
    const wagentEnvPath = path.resolve(root, '.env');
    const wagentEnv = parseEnvFile(wagentEnvPath);
    const env = { ...wagentEnv, ...process.env };
    const claraApiDir = path.resolve(root, env.CLARA_API_DIR || path.join('..', 'clara-api'));
    return {
        projectRoot: root,
        wagentEnvPath,
        claraApiDir,
        claraApiEnvPath: path.resolve(claraApiDir, '.env'),
        apiPyPath: path.resolve(claraApiDir, 'api.py'),
        queryDataPath: path.resolve(claraApiDir, 'query_data.py')
    };
}

const getApiUrlFromEnv = (env) => {
    if (env.CLARA_API_BASE_URL) return env.CLARA_API_BASE_URL;
    if (env.CLARA_API_URL) return env.CLARA_API_URL;
    const port = env.CLARA_API_PORT || '8010';
    const host = !env.CLARA_API_HOST || env.CLARA_API_HOST === '0.0.0.0'
        ? '127.0.0.1'
        : env.CLARA_API_HOST;
    return `http://${host}:${port}`;
};

const isRemotePath = (value = '') => /^(?:https?|s3):\/\//i.test(String(value || '').trim());

const resolveLocalPath = (value = '', baseDir = process.cwd()) => {
    const raw = String(value || '').trim();
    if (!raw || isRemotePath(raw)) return raw;
    return path.isAbsolute(raw) ? raw : path.resolve(baseDir, raw);
};

export function getClaraConfig() {
    const paths = resolveClaraPaths();
    const wagentEnv = parseEnvFile(paths.wagentEnvPath);
    const claraApiEnv = parseEnvFile(paths.claraApiEnvPath);
    const merged = {
        ...claraApiEnv,
        ...wagentEnv,
        ...process.env
    };
    const token = process.env.CLARA_API_TOKEN
        || process.env.CLARA_API_KEY
        || wagentEnv.CLARA_API_TOKEN
        || wagentEnv.CLARA_API_KEY
        || '';
    const parquetPathCandidates = [
        merged.CLARA_PARQUET_PATH,
        merged.PARQUET_PATH,
        DEFAULT_CLARA_PARQUET_PATH
    ].filter(Boolean).map(value => resolveLocalPath(value, paths.projectRoot));
    const readableParquetPath = parquetPathCandidates.find(candidate => !isRemotePath(candidate) && fs.existsSync(candidate));

    return {
        baseUrl: (getApiUrlFromEnv(merged) || DEFAULT_CLARA_API_URL).replace(/\/+$/, ''),
        token,
        limit: Number(merged.CLARA_API_LIMIT || DEFAULT_CLARA_LIMIT) || DEFAULT_CLARA_LIMIT,
        ...paths,
        wagentEnvLoaded: fs.existsSync(paths.wagentEnvPath),
        claraApiEnvLoaded: fs.existsSync(paths.claraApiEnvPath),
        parquetPath: readableParquetPath || parquetPathCandidates[0] || DEFAULT_CLARA_PARQUET_PATH,
        parquetPathCandidates,
        hasBaseUrl: Boolean(merged.CLARA_API_BASE_URL || merged.CLARA_API_URL || merged.CLARA_API_PORT),
        hasToken: Boolean(token),
        hasParquetPath: Boolean(merged.CLARA_PARQUET_PATH || merged.PARQUET_PATH),
        hasClaraParquetPath: Boolean(merged.CLARA_PARQUET_PATH)
    };
}

export function getClaraConfigDiagnostics() {
    const config = getClaraConfig();
    return {
        cwd: process.cwd(),
        projectRoot: config.projectRoot,
        claraApiDir: config.claraApiDir,
        claraApiDirExists: fs.existsSync(config.claraApiDir),
        apiPyExists: fs.existsSync(config.apiPyPath),
        queryDataPyExists: fs.existsSync(config.queryDataPath),
        envLoaded: config.wagentEnvLoaded,
        claraApiEnvLoaded: config.claraApiEnvLoaded,
        CLARA_API_BASE_URL_set: config.hasBaseUrl,
        CLARA_API_TOKEN_set: config.hasToken,
        CLARA_PARQUET_PATH_set: config.hasClaraParquetPath,
        PARQUET_PATH_set: config.hasParquetPath,
        parquetPathConfigured: config.hasParquetPath,
        parquetPathExists: fs.existsSync(config.parquetPath),
        baseUrl: config.baseUrl
    };
}
