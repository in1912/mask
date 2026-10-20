// 面具 mask — godlp stdio 适配器（Go）。
// 约定：stdin 进全文，stdout 只出 {"entities":[{term,start,end,type}]}，诊断日志全部走 stderr。
// godlp 的 DetectResult 用字节偏移，这里换算成 Unicode 码点偏移（与 Python/JS 侧一致）。
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"unicode/utf8"

	dlp "github.com/bytedance/godlp"
)

type entity struct {
	Term  string `json:"term"`
	Start int    `json:"start"`
	End   int    `json:"end"`
	Type  string `json:"type"`
}

type output struct {
	Entities []entity `json:"entities"`
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "godlp-cli:", err)
	os.Exit(1)
}

func main() {
	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		fail(err)
	}
	text := string(raw)

	// 引擎初始化/识别期间可能往 stdout 打日志；先把它引到 stderr，最后再恢复输出 JSON
	realOut := os.Stdout
	os.Stdout = os.Stderr

	eng, err := dlp.NewEngine("mask")
	if err != nil {
		os.Stdout = realOut
		fail(err)
	}
	defer eng.Close()
	if err := eng.ApplyConfig(dlp.DEF_CFG); err != nil {
		os.Stdout = realOut
		fail(err)
	}
	results, err := eng.Detect(text)
	os.Stdout = realOut
	if err != nil {
		fail(err)
	}

	ents := make([]entity, 0, len(results))
	for _, r := range results {
		if r == nil || r.ByteStart < 0 || r.ByteEnd > len(text) || r.ByteStart >= r.ByteEnd {
			continue
		}
		typ := r.InfoType
		if typ == "" {
			typ = r.EnName
		}
		ents = append(ents, entity{
			Term:  text[r.ByteStart:r.ByteEnd],
			Start: utf8.RuneCountInString(text[:r.ByteStart]),
			End:   utf8.RuneCountInString(text[:r.ByteEnd]),
			Type:  typ,
		})
	}
	enc := json.NewEncoder(realOut)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(output{Entities: ents}); err != nil {
		fail(err)
	}
}
