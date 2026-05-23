#!/usr/bin/env python3
"""
Baixa últimos jogos de cada uma das 48 seleções da Copa do Mundo 2026
do site national-football-teams.com e gera assets/data/recent.json.

Uso: python3 scripts/fetch_recent.py
"""
import json
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "data" / "recent.json"

TEAMS = {
    "Algeria":      (3,   "Algeria"),
    "Argentina":    (9,   "Argentina"),
    "Australia":    (12,  "Australia"),
    "Austria":      (13,  "Austria"),
    "Belgium":      (20,  "Belgium"),
    "Bosnia & Herzegovina": (26, "Bosnia_Herzegovina"),
    "Brazil":       (28,  "Brazil"),
    "Canada":       (36,  "Canada"),
    "Cape Verde":   (37,  "Cape_Verde"),
    "Colombia":     (43,  "Colombia"),
    "Croatia":      (47,  "Croatia"),
    "Curaçao":      (280, "Curacao"),
    "Czech Republic": (50, "Czechia"),
    "DR Congo":     (55,  "Dr_Congo"),
    "Ecuador":      (56,  "Ecuador"),
    "Egypt":        (57,  "Egypt"),
    "England":      (59,  "England"),
    "France":       (67,  "France"),
    "Germany":      (71,  "Germany"),
    "Ghana":        (72,  "Ghana"),
    "Haiti":        (81,  "Haiti"),
    "Iran":         (88,  "Iran"),
    "Iraq":         (89,  "Iraq"),
    "Ivory Coast":  (209, "Ivory_Coast"),
    "Japan":        (94,  "Japan"),
    "Jordan":       (95,  "Jordan"),
    "Mexico":       (121, "Mexico"),
    "Morocco":      (125, "Morocco"),
    "Netherlands":  (129, "Netherlands"),
    "New Zealand":  (132, "New_Zealand"),
    "Norway":       (138, "Norway"),
    "Panama":       (142, "Panama"),
    "Paraguay":     (144, "Paraguay"),
    "Portugal":     (148, "Portugal"),
    "Qatar":        (150, "Qatar"),
    "Saudi Arabia": (161, "Saudi_Arabia"),
    "Scotland":     (162, "Scotland"),
    "Senegal":      (163, "Senegal"),
    "South Africa": (172, "South_Africa"),
    "South Korea":  (173, "South_Korea"),
    "Spain":        (174, "Spain"),
    "Sweden":       (179, "Sweden"),
    "Switzerland":  (180, "Switzerland"),
    "Tunisia":      (190, "Tunisia"),
    "Turkey":       (192, "Turkey"),
    "USA":          (200, "Usa"),
    "Uruguay":      (198, "Uruguay"),
    "Uzbekistan":   (201, "Uzbekistan"),
}

YEARS = [2026, 2025, 2024]
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"

# regex pra cada <tr> de partida finalizada
ROW_RE = re.compile(
    r'<tr class="(?P<result>win|defeat|draw)"[^>]*itemprop="event"[^>]*>'
    r'.*?<td class="date"[^>]*>.*?(\d{4}-\d{2}-\d{2}).*?</td>'
    r'.*?<td class="teams country home[^"]*"[^>]*>'
    r'.*?href="/country/(?P<homeId>\d+)/'
    r'.*?<span itemprop="name">(?P<homeName>[^<]+)</span>'
    r'.*?<td class="teams country away[^"]*"[^>]*>'
    r'.*?href="/country/(?P<awayId>\d+)/'
    r'.*?<span itemprop="name">(?P<awayName>[^<]+)</span>'
    r'.*?<td class="result"[^>]*>'
    r'.*?>(?P<homeScore>\d+):(?P<awayScore>\d+)<'
    r'.*?<td class="event"[^>]*>'
    r'(?P<eventBlock>.*?)</td>',
    re.DOTALL
)

DATE_RE = re.compile(r'(\d{4})-(\d{2})-(\d{2})')

def fetch(url: str) -> str:
    try:
        r = subprocess.run(
            ["curl", "-s", "-A", USER_AGENT, url],
            capture_output=True, text=True, timeout=30
        )
        return r.stdout
    except Exception as e:
        print(f"  [erro] {url}: {e}", file=sys.stderr)
        return ""

def clean_comp(event_block: str, match_date: str = "") -> str:
    """event_block: conteúdo entre <td class="event"> e </td>.
    match_date: ISO date pra distinguir Copa vs Eliminatórias."""
    m = re.search(r'>([^<]+)</a>', event_block)
    txt = (m.group(1) if m else re.sub(r'<[^>]+>', '', event_block)).strip()
    txt = re.sub(r'\s+', ' ', txt)
    # CAN
    am = re.match(r'African 2025 - (.+)', txt, re.IGNORECASE)
    if am:
        sub = am.group(1).replace('Round of 16','Oitavas').replace('Quarter Finals','Quartas') \
            .replace('Semi Finals','Semis').replace('Group ','Grupo ').replace('3rd Place','3º lugar')
        return f"CAN 25 · {sub}"
    bm = re.match(r'Arab 2025 - (.+)', txt, re.IGNORECASE)
    if bm:
        sub = bm.group(1).replace('Quarter Finals','Quartas').replace('Semi Finals','Semis') \
            .replace('Group ','Grupo ').replace('3rd Place','3º lugar')
        return f"Copa Árabe 25 · {sub}"
    # Outras substituições por palavra-chave
    repl = [
        ("FIFA World Cup qualification", "Elim. 2026"),
        ("World Cup qualification", "Elim. 2026"),
        ("UEFA Nations League", "Liga das Nações"),
        ("Africa Cup of Nations", "CAN"),
        ("Asian Cup", "Copa da Ásia"),
        ("AFC Asian Cup", "Copa da Ásia"),
        ("Copa America", "Copa América"),
        ("CONCACAF Nations League", "Liga Concacaf"),
        ("CONCACAF Gold Cup", "Copa Ouro"),
        ("Friendly Match", "Amistoso"),
        ("Friendly", "Amistoso"),
    ]
    for k, v in repl:
        if k.lower() in txt.lower():
            return v
    # World Cup 2026: pré-11/06/2026 são Eliminatórias rotuladas erradamente
    if "World Cup 2026" in txt:
        if match_date and match_date < "2026-06-11":
            return "Elim. 2026"
        return "Copa 2026"
    return txt or "?"

def parse_matches(html: str, our_id: int):
    """Extrai partidas finalizadas da tabela #table-matches."""
    m = re.search(r'id="table-matches"(.*?)</table>', html, re.DOTALL)
    if not m:
        return []
    block = m.group(1)
    out = []
    for row in ROW_RE.finditer(block):
        d = row.groupdict()
        try:
            hs = int(d["homeScore"]); as_ = int(d["awayScore"])
        except ValueError:
            continue
        date_m = DATE_RE.search(row.group(0))
        if not date_m:
            continue
        date_iso = date_m.group(0)
        we_home = int(d["homeId"]) == our_id
        if we_home:
            score = f"{hs}-{as_}"
            opp = d["awayName"].strip()
        else:
            score = f"{as_}-{hs}"
            opp = d["homeName"].strip()
        out.append({
            "d": date_iso,
            "vs": opp,
            "h": we_home,
            "s": score,
            "c": clean_comp(d["eventBlock"], date_iso)
        })
    return out

def main():
    print(f"Baixando jogos de {len(TEAMS)} seleções...", file=sys.stderr)
    result = {}
    for our_en, (tid, slug) in TEAMS.items():
        all_matches = []
        for year in YEARS:
            url = f"https://national-football-teams.com/country/{tid}/{year}/{slug}.html"
            html = fetch(url)
            if not html or len(html) < 1000:
                continue
            ms = parse_matches(html, tid)
            all_matches.extend(ms)
            time.sleep(0.2)  # gentil com o servidor
            if len(all_matches) >= 8:
                break
        all_matches.sort(key=lambda x: x["d"], reverse=True)
        top5 = all_matches[:5]
        result[our_en] = [[m["d"], m["vs"], m["h"], m["s"], m["c"]] for m in top5]
        print(f"  {our_en:25s} -> {len(top5)} jogos", file=sys.stderr)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    total = sum(len(v) for v in result.values())
    print(f"\nGerado {OUT} ({total} jogos no total)", file=sys.stderr)

if __name__ == "__main__":
    main()
