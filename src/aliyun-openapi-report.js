import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { AliyunRpcClient } from './aliyun-rpc-client.js';
import { sendCouponEmail } from './email.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));

const defaultConfig = {
  outputDir: 'output',
  aliyun: {
    endpoint: 'business.aliyuncs.com',
    version: '2017-12-14',
    regionId: 'cn-hangzhou',
    currency: 'CNY',
    billingCycleMonths: 2,
    pageSize: 300,
  },
  email: {
    host: 'smtp.qq.com',
    port: 465,
    secure: true,
    attachJson: false,
    detailPreviewLimit: 20,
  },
};

function loadConfig() {
  const configPath = resolve(rootDir, 'config.json');
  if (!existsSync(configPath)) {
    return applyEnvConfig(defaultConfig);
  }

  const userConfig = JSON.parse(readFileSync(configPath, 'utf8'));
  return applyEnvConfig({
    ...defaultConfig,
    ...userConfig,
    aliyun: { ...defaultConfig.aliyun, ...(userConfig.aliyun ?? {}) },
    email: { ...defaultConfig.email, ...(userConfig.email ?? {}) },
  });
}

function applyEnvConfig(config) {
  return {
    ...config,
    outputDir: process.env.OUTPUT_DIR || config.outputDir,
    aliyun: {
      ...config.aliyun,
      endpoint: process.env.ALIYUN_BSS_ENDPOINT || config.aliyun.endpoint,
      version: process.env.ALIYUN_BSS_VERSION || config.aliyun.version,
      regionId: process.env.ALIYUN_REGION_ID || config.aliyun.regionId,
      currency: process.env.ALIYUN_CURRENCY || config.aliyun.currency,
      billingCycleMonths: Number(process.env.ALIYUN_BILLING_CYCLE_MONTHS || config.aliyun.billingCycleMonths),
      pageSize: Number(process.env.ALIYUN_PAGE_SIZE || config.aliyun.pageSize),
    },
  };
}

function ensureDir(path) {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function toArray(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  return [value];
}

function deepValues(value) {
  if (!value || typeof value !== 'object') {
    return [];
  }
  const values = [];
  for (const item of Object.values(value)) {
    if (Array.isArray(item)) {
      values.push(...item);
    } else if (item && typeof item === 'object') {
      values.push(item, ...deepValues(item));
    }
  }
  return values;
}

function findFirstArray(response) {
  const values = deepValues(response);
  return values.find((value) => Array.isArray(value)) || [];
}

function numeric(value) {
  if (value === null || value === undefined || value === '') {
    return 0;
  }
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function getField(object, names) {
  for (const name of names) {
    if (object?.[name] !== undefined && object?.[name] !== null && object?.[name] !== '') {
      return object[name];
    }
  }
  return undefined;
}

function compactObject(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

function monthCycles(count) {
  const cycles = [];
  const date = new Date();
  for (let index = 0; index < count; index += 1) {
    const cycle = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - index, 1));
    cycles.push(`${cycle.getUTCFullYear()}-${String(cycle.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return cycles;
}

function extractBalance(response) {
  const data = response.Data ?? response;
  const amount = getField(data, ['AvailableAmount', 'AvailableCashAmount', 'AccountBalance', 'Balance', 'CreditAmount']);
  if (amount === undefined) {
    return null;
  }
  return { amount: numeric(amount), source: 'QueryAccountBalance', text: String(amount) };
}

function normalizeCoupons(response) {
  const rawItems = toArray(response.Data?.CouponList?.Coupon)
    .concat(toArray(response.Data?.Coupons?.Coupon))
    .concat(toArray(response.Data?.Items?.Item));
  const items = rawItems.length ? rawItems : toArray(findFirstArray(response));

  return items.map((item) => compactObject({
    couponNo: getField(item, ['CouponNo', 'CouponId', 'Id']),
    name: getField(item, ['CouponName', 'Name', 'Description']),
    status: getField(item, ['Status', 'CouponStatus']),
    balance: getField(item, ['Balance', 'AvailableAmount', 'RemainAmount', 'RemainingAmount']),
    nominalValue: getField(item, ['NominalValue', 'Amount', 'FaceValue']),
    startTime: getField(item, ['StartTime', 'EffectiveTime']),
    expiryTime: getField(item, ['ExpiryTime', 'ExpiredTime', 'EndTime']),
    raw: item,
  }));
}

function normalizeDeductionDetails(response, billingCycle) {
  const rawItems = toArray(response.Data?.Items?.Item)
    .concat(toArray(response.Data?.BillingCycleData?.Items?.Item))
    .concat(toArray(response.Data?.InstanceBillList?.InstanceBill));
  const items = rawItems.length ? rawItems : toArray(findFirstArray(response));

  return items.map((item) => {
    const couponDeduct = getField(item, ['CouponDeduct', 'CouponDeductAmount', 'DeductAmount', 'CashCouponDeduct', 'VoucherDeductAmount']);
    const cashCoupon = getField(item, ['CashCoupon', 'CashCouponAmount', 'CashCouponDeduct']);
    const totalDeduct = numeric(couponDeduct) + numeric(cashCoupon);
    return compactObject({
      billingCycle,
      productName: getField(item, ['ProductName', 'ProductDetail', 'ProductCode']),
      instanceId: getField(item, ['InstanceID', 'InstanceId']),
      billAccountName: getField(item, ['BillAccountName', 'OwnerName']),
      pretaxAmount: getField(item, ['PretaxAmount', 'PretaxGrossAmount']),
      couponDeduct,
      cashCoupon,
      totalDeduct: totalDeduct || undefined,
      usageStartTime: getField(item, ['UsageStartTime', 'BillingDate']),
      usageEndTime: getField(item, ['UsageEndTime']),
      raw: item,
    });
  }).filter((item) => numeric(item.totalDeduct) > 0 || numeric(item.couponDeduct) > 0 || numeric(item.cashCoupon) > 0);
}

async function callPaged(client, action, baseParams, pageSize) {
  const results = [];
  const errors = [];
  for (let pageNum = 1; pageNum <= 50; pageNum += 1) {
    try {
      const response = await client.call(action, { ...baseParams, PageNum: pageNum, PageSize: pageSize });
      results.push(response);
      const totalCount = Number(response.Data?.TotalCount ?? response.TotalCount ?? 0);
      if (!totalCount || pageNum * pageSize >= totalCount) {
        break;
      }
    } catch (error) {
      errors.push({ action, params: baseParams, message: error.message, response: error.response });
      break;
    }
  }
  return { results, errors };
}

function toCsv(rows) {
  if (!rows.length) {
    return '';
  }
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row).filter((key) => key !== 'raw')))];
  const escape = (value) => {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers.join(','), ...rows.map((row) => headers.map((header) => escape(row[header])).join(','))].join('\n');
}

async function buildReport() {
  const config = loadConfig();
  const outputDir = resolve(rootDir, config.outputDir);
  ensureDir(outputDir);

  const client = new AliyunRpcClient({
    accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID,
    accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET,
    endpoint: config.aliyun.endpoint,
    version: config.aliyun.version,
    regionId: config.aliyun.regionId,
  });

  const apiErrors = [];
  let balance = null;
  let balanceResponse = null;
  try {
    balanceResponse = await client.call('QueryAccountBalance');
    balance = extractBalance(balanceResponse);
  } catch (error) {
    apiErrors.push({ action: 'QueryAccountBalance', message: error.message, response: error.response });
  }

  const couponCall = await callPaged(client, 'QueryCashCoupons', { Status: process.env.ALIYUN_COUPON_STATUS || 'Available' }, config.aliyun.pageSize);
  apiErrors.push(...couponCall.errors);
  const coupons = couponCall.results.flatMap(normalizeCoupons);

  const deductionDetails = [];
  for (const billingCycle of monthCycles(config.aliyun.billingCycleMonths)) {
    const billCall = await callPaged(client, 'QueryInstanceBill', { BillingCycle: billingCycle }, config.aliyun.pageSize);
    apiErrors.push(...billCall.errors);
    deductionDetails.push(...billCall.results.flatMap((response) => normalizeDeductionDetails(response, billingCycle)));
  }

  const result = {
    crawledAt: new Date().toISOString(),
    url: 'aliyun://BssOpenApi',
    balance,
    coupons,
    deductionDetails,
    apiErrors,
    apiSamples: {
      balanceResponse,
      couponResponses: couponCall.results,
    },
  };

  const jsonPath = resolve(outputDir, 'aliyun-coupon-result.json');
  const csvPath = resolve(outputDir, 'aliyun-coupon-deductions.csv');
  const couponsPath = resolve(outputDir, 'aliyun-coupons.csv');
  writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  writeFileSync(csvPath, toCsv(deductionDetails), 'utf8');
  writeFileSync(couponsPath, toCsv(coupons), 'utf8');
  return { config, result, jsonPath, csvPath, couponsPath };
}

export async function runOpenApiReport({ email = args.has('--email') } = {}) {
  const report = await buildReport();
  if (email) {
    await sendCouponEmail(report);
    console.log('邮件已发送。');
  }
  console.log(`账户余额：${report.result.balance?.amount ?? '未识别'}`);
  console.log(`可用优惠券：${report.result.coupons.length} 条`);
  console.log(`抵扣明细：${report.result.deductionDetails.length} 条`);
  if (report.result.apiErrors.length) {
    console.log(`API 警告：${report.result.apiErrors.length} 条，详见 JSON。`);
  }
  console.log(`JSON：${report.jsonPath}`);
  console.log(`抵扣明细 CSV：${report.csvPath}`);
  console.log(`优惠券 CSV：${report.couponsPath}`);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runOpenApiReport().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
