package local.mask;

import com.github.houbb.sensitive.word.bs.SensitiveWordBs;

import java.io.InputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * 面具 mask — sensitive-word stdio 适配器。
 * 约定：stdin 进全文，stdout 只出 {"entities":[{term,start,end,type}]}，日志走 stderr。
 * Java String 下标就是 UTF-16 单元，与 JS 侧完全一致，无需换算。
 */
public final class SensitiveWordCli {
    private SensitiveWordCli() {
    }

    public static void main(String[] args) throws Exception {
        byte[] raw = readAll(System.in);
        String text = new String(raw, StandardCharsets.UTF_8);

        PrintStream realOut = System.out;
        System.setOut(System.err); // 词库初始化日志别污染 JSON

        SensitiveWordBs bs = SensitiveWordBs.newInstance()
                .enableNumCheck(false)
                .enableEmailCheck(false)
                .enableUrlCheck(false)
                .init();
        List<String> words = bs.findAll(text);

        System.setOut(realOut);

        List<int[]> spans = new ArrayList<>();
        List<String> terms = new ArrayList<>();
        for (String w : words) {
            if (w == null || w.isEmpty()) {
                continue;
            }
            int from = 0;
            while (from <= text.length() - w.length()) {
                int i = text.indexOf(w, from);
                if (i < 0) {
                    break;
                }
                terms.add(w);
                spans.add(new int[]{i, i + w.length()});
                from = i + w.length();
            }
        }

        StringBuilder sb = new StringBuilder(64 + terms.size() * 48);
        sb.append("{\"entities\":[");
        for (int k = 0; k < terms.size(); k++) {
            if (k > 0) {
                sb.append(',');
            }
            sb.append("{\"term\":").append(json(terms.get(k)))
              .append(",\"start\":").append(spans.get(k)[0])
              .append(",\"end\":").append(spans.get(k)[1])
              .append(",\"type\":\"SENSITIVE_WORD\"}");
        }
        sb.append("]}");
        realOut.println(sb);
        realOut.flush();
    }

    private static byte[] readAll(InputStream in) throws Exception {
        return in.readAllBytes();
    }

    private static String json(String s) {
        StringBuilder b = new StringBuilder(s.length() + 2);
        b.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (c < 0x20) {
                        b.append(String.format("\\u%04x", (int) c));
                    } else {
                        b.append(c);
                    }
            }
        }
        b.append('"');
        return b.toString();
    }
}
