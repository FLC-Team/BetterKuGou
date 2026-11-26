// Adapted from MakcRe/KuGouMusicApi module/user_update.js (MIT, Copyright (c) 2023 MakcRe).
// Upstream: https://github.com/MakcRe/KuGouMusicApi/blob/main/module/user_update.js
// The complete MIT notice remains in ../LICENSE. Only explicitly edited profile fields are forwarded.
const { cryptoRSAEncrypt, signParamsKey } = require('../util');
const { appid, clientver, liteAppid, liteClientver } = require('../util/config.json');

const invalid = (status, message) => Promise.reject({ status, headers: {}, cookie: [], body: { status: 0, error_code: status, error: message } });

/** Preserve upstream RSA authentication and direct user-service protocol; never forward arbitrary account fields. */
module.exports = (params, useAxios) => {
  const token = params?.token || params?.cookie?.token;
  const userid = Number(params?.userid || params?.cookie?.userid);
  if (typeof token !== 'string' || !token || !Number.isSafeInteger(userid) || userid <= 0) return invalid(401, '请先登录酷狗账号');
  const data = {};
  for (const field of ['nickname', 'signature', 'sex', 'birthday']) {
    if (!Object.prototype.hasOwnProperty.call(params, field)) continue;
    const value = params[field];
    if (field === 'sex') {
      if (!['0', '1', '2'].includes(String(value)) || !['string', 'number'].includes(typeof value)) return invalid(400, '性别选项无效');
      data.sex = String(value);
    } else {
      if (typeof value !== 'string') return invalid(400, '资料字段格式无效');
      if (field === 'nickname' && (!value.trim() || value.trim().length > 50)) return invalid(400, '昵称需为 1–50 个字符');
      if (field === 'signature' && value.length > 200) return invalid(400, '个性签名不能超过 200 个字符');
      if (field === 'birthday' && value !== '' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) return invalid(400, '生日日期无效');
      data[field] = field === 'nickname' ? value.trim() : value;
    }
  }
  if (!Object.keys(data).length) return invalid(400, '至少需要提供一项要修改的资料');
  const isLite = process.env.platform === 'lite';
  const useAppid = isLite ? liteAppid : appid;
  const useClientver = isLite ? liteClientver : clientver;
  const clienttime = Math.floor(Date.now() / 1000);
  return useAxios({
    baseURL: 'http://update.user.kugou.com',
    url: '/v1/update_userinfo',
    method: 'POST',
    encryptType: 'android',
    data: { clienttime, appid: useAppid, clientver: useClientver,
      mid: String(params?.mid || params?.cookie?.KUGOU_API_MID || ''), uuid: '-', userid,
      key: signParamsKey(clienttime, useAppid, useClientver),
      p: cryptoRSAEncrypt(JSON.stringify({ clienttime, token })).toUpperCase(), data },
    cookie: params?.cookie || {},
    clearDefaultParams: true,
    notSignature: true,
  });
};
