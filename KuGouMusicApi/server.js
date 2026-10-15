const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const decode = require('safe-decode-uri-component');
const { cookieToJson } = require('./util/util');
const { createRequest } = require('./util/request');
const dotenv = require('dotenv');
const cache = require('./util/apicache').middleware;

const SENSITIVE_QUERY_KEYS = new Set(['token', 'vip_token', 'cookie', 'password', 'pwd', 'key', 'accesskey', 'access_key', 'code', 'captcha', 'mobile', 'username', 'userid']);

/** 日志仅保留路由及非敏感查询参数，直接解析原始 URL 以免预解码改变参数边界。 */
function getSafeRequestUrl(originalUrl) {
  try {
    const parsed = new URL(originalUrl, 'http://localhost');
    for (const key of parsed.searchParams.keys()) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
        parsed.searchParams.set(key, '[REDACTED]');
      }
    }
    return `${parsed.pathname}${parsed.search}`;
  } catch (_) {
    return originalUrl.split('?')[0];
  }
}

/** 保留标准异常诊断字段，不展开 Axios 的请求配置、Cookie 或响应正文。 */
function getSafeErrorDetails(error, depth = 0) {
  if (!error || typeof error.stack !== 'string' || depth > 2) return undefined;
  const redact = (value) => typeof value === 'string' ? value
    .replace(/Bearer\s+[\w.~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(token|vip_token|cookie|password|pwd|key|accesskey|code|mobile|userid|username)(=|%3D)[^&\s]+/gi, '$1$2[REDACTED]') : value;
  return {
    name: error.name,
    code: error.code,
    message: redact(error.message),
    stack: redact(error.stack),
    cause: getSafeErrorDetails(error.cause, depth + 1),
  };
}

/**
 * @typedef {{
 * identifier?: string,
 * route: string,
 * module: any,
 * }}ModuleDefinition
 */

/**
 * @typedef {{
*  server?: import('http').Server,
* }} ExpressExtension
*/

const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({path: envPath, quiet: true});
}

/**
 *  描述：动态获取模块定义
 * @param {string}  modulesPath  模块路径(TS)
 * @param {Record<string, string>} specificRoute  特定模块定义
 * @param {boolean} doRequire  如果为 true，则使用 require 加载模块, 否则打印模块路径， 默认为true
 * @return { Promise<ModuleDefinition[]> }
 * @example getModuleDefinitions("./module", {"album_new.js": "/album/create"})
 */
async function getModulesDefinitions(modulesPath, specificRoute, doRequire = true) {
  const files = await fs.promises.readdir(modulesPath);
  const parseRoute = (fileName) =>
    specificRoute && fileName in specificRoute ? specificRoute[fileName] : `/${fileName.replace(/\.(js)$/i, '').replace(/_/g, '/')}`;

  return files
    .reverse()
    .filter((fileName) => fileName.endsWith('.js') && !fileName.startsWith('_'))
    .map((fileName) => {
      const identifier = fileName.split('.').shift();
      const route = parseRoute(fileName);
      const modulePath = path.resolve(modulesPath, fileName);
      const module = doRequire ? require(modulePath) : modulePath;
      return { identifier, route, module };
    });
}

/**
 * 创建服务
 * @param {ModuleDefinition[]} moduleDefs
 * @return {Promise<import('express').Express>}
 */
async function constructServer(moduleDefs) {
  const app = express();
  const { CORS_ALLOW_ORIGIN } = process.env;
  app.set('trust proxy', true);

  /**
   * CORS & Preflight request
   */
  app.use((req, res, next) => {
    if (req.path !== '/' && !req.path.includes('.')) {
      res.set({
        'Access-Control-Allow-Credentials': true,
        'Access-Control-Allow-Origin': CORS_ALLOW_ORIGIN || req.headers.origin || '*',
        'Access-Control-Allow-Headers': 'X-Requested-With,Content-Type,Authorization',
        'Access-Control-Allow-Methods': 'PUT,POST,GET,DELETE,OPTIONS',
        'Content-Type': 'application/json; charset=utf-8',
      });
    }
    req.method === 'OPTIONS' ? res.status(204).end() : next();
  });

  // Cookie Parser
  app.use((req, _, next) => {
    req.cookies = {};
    (req.headers.cookie || '').split(/;\s+|(?<!\s)\s+$/g).forEach((pair) => {
      const crack = pair.indexOf('=');
      if (crack < 1 || crack === pair.length - 1) {
        return;
      }
      req.cookies[decode(pair.slice(0, crack)).trim()] = decode(pair.slice(crack + 1)).trim();
    });
    next();
  });

  // 将当前平台写入Cookie 以方便查看
  app.use((req, res, next) => {
    const cookies = (req.headers.cookie || '').split(/;\s+|(?<!\s)\s+$/g);
    if (!cookies.includes('KUGOU_API_PLATFORM')) {
      if (req.protocol === 'https') {
        res.append('Set-Cookie', `KUGOU_API_PLATFORM=${process.env.platform}; PATH=/; SameSite=None; Secure`);
      } else {
        res.append('Set-Cookie', `KUGOU_API_PLATFORM=${process.env.platform}; PATH=/`);
      }
    }

    next();
  });

  // Body Parser
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  /**
   * Serving static files
   */
  app.use(express.static(path.join(__dirname, 'public')));

  /**
   * docs
   */

  app.use('/docs', express.static(path.join(__dirname, 'docs')));

  // Cache
  const publicCache = cache('2 minutes', (_, res) => res.statusCode === 200, {
    appendKey: (req) => req.headers.origin || '',
  });
  app.use((req, res, next) => {
    // 缓存键不包含请求体/认证头；只缓存公开 GET，避免混用登录返回和用户数据。
    const hasCredentials = req.headers.authorization
      || Object.keys(req.query).some((key) => SENSITIVE_QUERY_KEYS.has(key.toLowerCase()))
      || Object.keys(req.cookies).some((key) => key !== 'KUGOU_API_PLATFORM');
    const isPrivateRoute = /^\/(login|captcha|register|user|personal|everyday|playhistory|playlist\/(add|del|tracks)|artist\/(follow|unfollow))(\/|$)/i.test(req.path);
    if (req.method !== 'GET' || Object.keys(req.body || {}).length || hasCredentials || isPrivateRoute) return next();
    return publicCache(req, res, next);
  });

  const moduleDefinitions = moduleDefs || (await getModulesDefinitions(path.join(__dirname, 'module'), {}));

  for (const moduleDef of moduleDefinitions) {
    app.use(moduleDef.route, async (req, res) => {
      [req.query, req.body].forEach((item) => {
        if (typeof item.cookie === 'string') {
          item.cookie = cookieToJson(decode(item.cookie));
        }
      });

      // 请求体映射到模块顶层，查询参数保留既有优先级，同时兼容直接读取 body 的调用。
      const query = { cookie: req.cookies, ...req.body, ...req.query, body: req.body };

      try {
        const moduleResponse = await moduleDef.module(query, (config) => {
          let ip = req.ip;
          if (ip.substring(0, 7) === '::ffff:') {
            ip = ip.substring(7);
          }
          config.ip = ip;
          return createRequest(config);
        });

        if (process.env.DEBUG) console.debug('[OK]', getSafeRequestUrl(req.originalUrl));

        const cookies = moduleResponse.cookie;
        if (!query.noCookie) {
          if (Array.isArray(cookies) && cookies.length > 0) {
            if (req.protocol === 'https') {
              // Try to fix CORS SameSite Problem
              res.append(
                'Set-Cookie',
                cookies.map((cookie) => {
                  return `${cookie}; PATH=/; SameSite=None; Secure`;
                })
              );
            } else {
              res.append(
                'Set-Cookie',
                cookies.map((cookie) => {
                  return `${cookie}; PATH=/`;
                })
              );
            }
          }
        }

        res.header(moduleResponse.headers).status(moduleResponse.status).send(moduleResponse.body);
      } catch (e) {
        const moduleResponse = e;
        console.error('[ERR]', getSafeRequestUrl(req.originalUrl), {
          status: moduleResponse.status,
          code: moduleResponse.body?.error_code ?? moduleResponse.body?.code,
          name: moduleResponse.name,
          exception: getSafeErrorDetails(moduleResponse) || getSafeErrorDetails(moduleResponse.body?.msg),
        });

        if (!moduleResponse.body) {
          res.status(404).send({
            code: 404,
            data: null,
            msg: 'Not Found',
          });
          return;
        }

        res.header(moduleResponse.headers).status(moduleResponse.status).send(moduleResponse.body);
      }
    });
  }

  return app;
}

/**
 * Serve the KG API
 * @returns {Promise<import('express').Express & ExpressExtension>}
 */
async function startService() {
  const port = Number(process.env.PORT || '6500');
  const host = process.env.HOST || '';

  const app = await constructServer();

  /** @type {import('express').Express & ExpressExtension} */
  const appExt = app;

  await new Promise((resolve, reject) => {
    appExt.service = app.listen(port, host, resolve);
    appExt.service.once('error', reject);
  });
  console.log(`server running @ http://${host || 'localhost'}:${appExt.service.address().port}`);

  return appExt;
}

module.exports = { startService, getModulesDefinitions, constructServer };
