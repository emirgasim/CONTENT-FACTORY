const skills = [
  ["yt-script","Senaryo, beş kanca alternatifi ve puanlama"],
  ["yt-package","Başlık ve kapak uyumu"],
  ["yt-edit","Sessizlik, dolgu kelimeleri ve kurgu listesi"],
  ["yt-comment","Yorumları sınıflandırma ve cevap taslağı"],
  ["yt-plan","Haftalık yayın planı"],
  ["yt-viral","Rakip videoları kanal medyanına göre kıyaslama"],
  ["yt-retention","İzleyici tutma grafiği analizi"],
  ["yt-shorts","Uzun videodan Shorts fikirleri çıkarma"],
  ["yt-seo","Başlık, açıklama, etiket ve arama sorguları"],
  ["yt-chapters","Zaman damgalı bölüm listesi"],
  ["yt-audit","Kanal denetimi ve öncelikli iyileştirme"]
];
export async function onRequestGet() {
  return Response.json({
    ok: true,
    name: "Content Factory Agent Hub",
    mode: "cloudflare-pages-free",
    execution: "Cloudflare Pages Functions",
    claude_required: false,
    external_api_key_required: false,
    skills: skills.map(([id, description]) => ({ id, description })),
    tools: ["hookscore","title","deadair","chapters","retention","viral"]
  }, { headers: { "Cache-Control": "no-store" } });
}
