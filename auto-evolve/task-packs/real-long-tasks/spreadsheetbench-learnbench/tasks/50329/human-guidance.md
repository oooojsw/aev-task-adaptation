I have two columns with dates and need to set up a formula in Column J with multiple IF conditions to manage the following scenarios: 1. Column J should remain blank if both Columns F and G are blank. 2. Column J should display 'Yes' if there is an entry in Column F, regardless of whether Column G has an entry or not. 3. Column J should display 'No' if Column F is blank and Column G has an entry. My attempts at creating a fitting formula have been unsuccessful so far, and I have provided an example sheet with expected results for each scenario.
   1. The column to stay blank with no text in it if both Columns F and G are left blank.
   2. For it give me an output of "Yes" if something is written in Column F.
   3. For the output to give me a "No" if Column F is blank but something is written in Column G.

My current formula is:  
IF([@Column6],"Yes","No"),IF(ISBLANK(Table1[@[Column6]:[Column7]],""))
