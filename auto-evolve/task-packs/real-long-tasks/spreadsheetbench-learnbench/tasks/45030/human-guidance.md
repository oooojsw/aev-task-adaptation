How can I find the closest value that is 'At Least' a certain cost within a tier range using an Excel formula, without getting an exact match only? I have tried using INDEX/MATCH but it doesn't return the closest value if there is no exact match. I'm looking for a formula that can handle this and an example Excel file is attached for clarity.In column B, find the Tier that falls within the "At Least and Less Than" range.The current index/match formula only works if there is an exact match. 
My current formula is:
IFERROR(@INDEX($E$7:$E$19,MATCH(C7,$E$7:$E$19,0)),"")
