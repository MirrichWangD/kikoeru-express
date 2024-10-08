const cheerio = require("cheerio"); // 解析器

const axios = require("./axios"); // 数据请求
const { nameToUUID, hasLetter } = require("./utils");

let asmrOneApiUrl = "";

async function updateAsmrOneApiUrl() {
  const url = `https://asmr.one/index.html`;
  try {
    const response = await axios.retryGet(url, {
      retry: {},
      headers: { cookie: "locale=zh-cn" },
    });

    const $ = cheerio.load(response.data);

    asmrOneApiUrl = $('link[rel="preconnect"][as="fetch"]').attr("href");

    console.log("asmr one api url = ", asmrOneApiUrl);
  } catch {
    console.warn("获取ASMROne api url失败");
  }
}

async function scrapeWorkMetadataFromAsmrOne(id) {
  if (asmrOneApiUrl === "") await updateAsmrOneApiUrl();

  const rjcode = id;
  const url = `https://api.asmr-200.com/api/workInfo/${rjcode}`;

  console.log(`-> [RJ${rjcode}] 从 asmr-one 抓取 Dynamic 元数据中...`);
  const response = await axios.retryGet(url, {
    retry: {},
    headers: { cookie: "locale=zh-cn" },
  });
  // console.log(`RJ${rjcode} asmr one data = `, response.data);
  // const data = JSON.parse(response.data);
  const data = response.data;

  // va的UUID可能和asmrOne不同，这里做一次强制转换
  data.vas.forEach((va) => {
    va.id = nameToUUID(va.name);
  });

  return data;
}

module.exports = {
  scrapeWorkMetadataFromAsmrOne,
};
