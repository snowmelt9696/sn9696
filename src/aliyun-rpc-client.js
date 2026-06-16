import crypto from 'node:crypto';
import https from 'node:https';

function percentEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

function timestamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function nonce() {
  return crypto.randomBytes(16).toString('hex');
}

function signParams(params, accessKeySecret) {
  const canonicalizedQuery = Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join('&');
  const stringToSign = `GET&${percentEncode('/')}&${percentEncode(canonicalizedQuery)}`;
  return crypto.createHmac('sha1', `${accessKeySecret}&`).update(stringToSign).digest('base64');
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (response.statusCode >= 400 || data.Code || data.Message?.includes('Error')) {
            const error = new Error(data.Message || `Aliyun API HTTP ${response.statusCode}`);
            error.response = data;
            reject(error);
            return;
          }
          resolve(data);
        } catch (error) {
          error.responseBody = body;
          reject(error);
        }
      });
    }).on('error', reject);
  });
}

export class AliyunRpcClient {
  constructor({ accessKeyId, accessKeySecret, endpoint = 'business.aliyuncs.com', version = '2017-12-14', regionId }) {
    if (!accessKeyId || !accessKeySecret) {
      throw new Error('缺少阿里云 AccessKey：请设置 ALIYUN_ACCESS_KEY_ID 和 ALIYUN_ACCESS_KEY_SECRET。');
    }
    this.accessKeyId = accessKeyId;
    this.accessKeySecret = accessKeySecret;
    this.endpoint = endpoint;
    this.version = version;
    this.regionId = regionId;
  }

  async call(action, params = {}) {
    const query = {
      Format: 'JSON',
      Version: this.version,
      AccessKeyId: this.accessKeyId,
      SignatureMethod: 'HMAC-SHA1',
      Timestamp: timestamp(),
      SignatureVersion: '1.0',
      SignatureNonce: nonce(),
      Action: action,
      ...params,
    };
    if (this.regionId) {
      query.RegionId = this.regionId;
    }

    query.Signature = signParams(query, this.accessKeySecret);
    const queryString = Object.keys(query)
      .sort()
      .map((key) => `${percentEncode(key)}=${percentEncode(query[key])}`)
      .join('&');
    return requestJson(`https://${this.endpoint}/?${queryString}`);
  }
}
