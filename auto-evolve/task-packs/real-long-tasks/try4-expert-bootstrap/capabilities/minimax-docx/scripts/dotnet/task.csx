using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Wordprocessing;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;

var templatePath = args[0];
var outputPath = args[1];
var replacementsJson = args[2];

File.Copy(templatePath, outputPath, true);

using var doc = WordprocessingDocument.Open(outputPath, true);
var body = doc.MainDocumentPart.Document.Body;

var replacements = System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, string>>(replacementsJson);

foreach (var para in body.Descendants<Paragraph>())
{
    foreach (var run in para.Descendants<Run>())
    {
        var textEl = run.GetFirstChild<Text>();
        if (textEl == null) continue;
        
        foreach (var kvp in replacements)
        {
            if (textEl.Text.Contains(kvp.Key))
            {
                textEl.Text = textEl.Text.Replace(kvp.Key, kvp.Value);
            }
        }
    }
}

foreach (var headerPart in doc.MainDocumentPart.HeaderParts)
{
    var headerBody = headerPart.Header;
    foreach (var para in headerBody.Descendants<Paragraph>())
    {
        foreach (var run in para.Descendants<Run>())
        {
            var textEl = run.GetFirstChild<Text>();
            if (textEl == null) continue;
            
            foreach (var kvp in replacements)
            {
                if (textEl.Text.Contains(kvp.Key))
                {
                    textEl.Text = textEl.Text.Replace(kvp.Key, kvp.Value);
                }
            }
        }
    }
}

foreach (var footerPart in doc.MainDocumentPart.FooterParts)
{
    var footerBody = footerPart.Footer;
    foreach (var para in footerBody.Descendants<Paragraph>())
    {
        foreach (var run in para.Descendants<Run>())
        {
            var textEl = run.GetFirstChild<Text>();
            if (textEl == null) continue;
            
            foreach (var kvp in replacements)
            {
                if (textEl.Text.Contains(kvp.Key))
                {
                    textEl.Text = textEl.Text.Replace(kvp.Key, kvp.Value);
                }
            }
        }
    }
}

doc.Save();
Console.WriteLine("Fill complete: " + outputPath);