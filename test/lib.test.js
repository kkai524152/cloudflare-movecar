import test from "node:test";
import assert from "node:assert/strict";

import {
  cleanMessage,
  escapeHtml,
  mapUrls,
  maskPhone,
  normalizeLocation,
  phoneForTel,
  publicBaseUrl,
} from "../src/lib.js";

test("cleanMessage normalizes control characters and caps length", () => {
  assert.equal(cleanMessage("  挡住\n出口了  "), "挡住 出口了");
  assert.equal(cleanMessage(""), "这里有辆车需要驶出，请帮忙挪一下");
  assert.equal(cleanMessage("车".repeat(100)).length, 80);
});

test("normalizeLocation validates ranges and rounds values", () => {
  assert.deepEqual(normalizeLocation({ lat: 31.2304162, lng: 121.4737019, accuracy: 18.6 }), {
    lat: 31.230416,
    lng: 121.473702,
    accuracy: 19,
  });
  assert.equal(normalizeLocation({ lat: 91, lng: 0 }), null);
  assert.equal(normalizeLocation(null), null);
});

test("phone helpers validate and mask phone values", () => {
  assert.equal(phoneForTel("138 0013 8000"), "13800138000");
  assert.equal(phoneForTel("not-a-phone"), null);
  assert.equal(maskPhone("13800138000"), "138****8000");
});

test("escapeHtml covers push message interpolation", () => {
  assert.equal(escapeHtml('<b a="x">\'&'), "&lt;b a=&quot;x&quot;&gt;&#039;&amp;");
});

test("publicBaseUrl only accepts secure configured origins", () => {
  assert.equal(publicBaseUrl("https://worker.example/api", "https://move.example/path"), "https://move.example");
  assert.equal(publicBaseUrl("https://worker.example/api", "http://unsafe.example"), "https://worker.example");
});

test("mapUrls returns usable map links", () => {
  const urls = mapUrls({ lat: 31.230416, lng: 121.473701 }, "测试位置");
  assert.match(urls.amap, /^https:\/\/uri\.amap\.com\/marker\?/);
  assert.match(urls.apple, /^https:\/\/maps\.apple\.com\/\?/);
  assert.equal(mapUrls(null), null);
});
