# KnowNo conformal tool selection — offline report (gemma4:12b, α=0.1, LOO over 14 cases)

| prompt | true | prediction set | covered |
|---|---|---|---|
| What time is it now? | time_now | {time_now} | ✓ |
| What day of the week is it right now in Se | time_now | {time_now} | ✓ |
| 오늘 며칠이야? | time_now | {time_now} | ✓ |
| How many hours between 9am and 5:30pm toda | time_diff | {} | ✗ |
| What is 3 days after 2026-05-26? | time_add | {time_add} | ✓ |
| How long ago was 2026-05-01 from now? | time_relative | {time_relative} | ✓ |
| 2026-05-01이 얼마나 지난 거야? | time_relative | {time_relative} | ✓ |
| When is the next Friday? | next_weekday_date | {next_weekday_date} | ✓ |
| 다음 주 금요일이 며칠이야? | next_weekday_date | {next_weekday_date} | ✓ |
| Give me a cron expression for 2026-12-25 0 | cron_for_datetime | {cron_for_datetime} | ✓ |
| 시간 참 빨리 간다, 벌써 금요일이네. | none | {none} | ✓ |
| What a beautiful Friday morning, isn't it? | none | {none} | ✓ |
| 오늘 정말 긴 하루였어. | none | {none} | ✓ |
| Time really does fly when you're having fu | none | {none} | ✓ |

- coverage (true label in set): 13/14 (target ≥ 90%)
- would-have-clarified (|set|>1): 0/14
- wrong-but-confident (|set|=1, wrong): 0/14
- mean set size: 0.93
