# Discrete semantic entropy — offline report (gemma4:12b, k=4, 8+8 cases)

| kind | query | entropy | retrieval |
|---|---|---|---|
| answerable | when does my home insurance renew? | 0.562 | ambiguous |
| answerable | who owns pricing for the Q3 launch? | 0.000 | confident |
| answerable | what MTU did I set for the office VPN? | 0.000 | confident |
| answerable | what is my monthly rent? | 0.000 | ambiguous |
| answerable | what is Sarah's email address? | 0.000 | ambiguous |
| answerable | when is the dentist cleaning due? | 0.693 | confident |
| answerable | at what mileage is my next oil change? | 0.000 | confident |
| answerable | what is my home wifi SSID? | 0.000 | confident |
| refuse | what is my blood type? | 0.000 | ambiguous |
| refuse | what is my mother's maiden name? | 0.000 | ambiguous |
| refuse | how much did I spend on groceries last m | 0.000 | ambiguous |
| refuse | what is my streaming account password? | 0.000 | ambiguous |
| refuse | when is my next flight departure? | 0.000 | ambiguous |
| refuse | what was the name of my childhood pet? | 0.000 | ambiguous |
| refuse | what time is my haircut appointment this | 0.000 | ambiguous |
| refuse | what is the boiling point of mercury in  | 0.000 | ambiguous |

- semantic-entropy AUROC (refuse vs answerable): 0.375
- retrieval-confidence baseline AUROC: 0.813
- verdict: SE does NOT beat the existing retrieval baseline — do not adopt
