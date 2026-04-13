using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Wordprocessing;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

class Program
{
    static void Main(string[] args)
    {
        if (args.Length < 2)
        {
            Console.WriteLine("Usage: Program.exe <template.docx> <output.docx>");
            return;
        }

        string templatePath = args[0];
        string outputPath = args[1];

        // Copy template to output
        File.Copy(templatePath, outputPath, true);

        // Dictionary of placeholder keys and values
        var replacements = new Dictionary<string, string>
        {
            {"产权持有人", "江苏省国信集团有限公司"},
            {"评估基准日", "2026年3月23日"},
            {"评估目的", "为江苏省国信集团有限公司拟转让南京恩瑞特实业有限公司股权涉及的固定资产提供市场价值参考依据"},
            {"资产占有方", "江苏省国信集团有限公司"},
            {"评估范围", "南京恩瑞特实业有限公司申报评估的固定资产"},
            {"评估方法", "成本法"},
            {"评估结论", "委估资产在评估基准日的评估价值为人民币贰万贰仟捌佰玖拾叁万捌仟元整（¥228,938,000.00）"},
            {"备注", ""},
            {"权属", "标的资产权属清晰，无查封、抵押等权利限制"},
            {"项目名称", "南京恩瑞特实业有限公司股权评估项目"},
            {"评估机构", "江苏华晨资产评估有限公司"},
            {"签字评估师", "张明、李四"},
            {"项目负责人", "王五"},
            {"审核人", "刘六"},
            {"委托方", "江苏省国信集团有限公司"},
            {"资产使用方", "南京恩瑞特实业有限公司"},
            {"表4-6标题", "固定资产评估汇总表"},
            {"评估价值大写", "贰万贰仟捌佰玖拾叁万捌仟元整"},
            {"评估价值数字", "228,938,000.00"},
            {"报告编号", "苏华晨评报字(2026)第001号"},
            {"原值", "20,260"},
            {"评估值", "22,893.8"},
            {"增值", "2,633.8"},
            {"增值率", "13%"},
            {"增值额合计", "2,633.8万元"},
        };

        using (var doc = WordprocessingDocument.Open(outputPath, true))
        {
            var body = doc.MainDocumentPart.Document.Body;
            int replaced = 0;

            // Process all text elements
            var textElements = body.Descendants<Text>().ToList();
            foreach (var textEl in textElements)
            {
                string content = textEl.Text;
                foreach (var kvp in replacements)
                {
                    string placeholder = "\u3010" + kvp.Key + "\u3011";
                    if (content.Contains(placeholder))
                    {
                        content = content.Replace(placeholder, kvp.Value);
                        replaced++;
                    }
                }
                textEl.Text = content;
            }

            doc.MainDocumentPart.Document.Save();
            Console.WriteLine($"Replaced {replaced} placeholders");
        }

        Console.WriteLine($"Output: {outputPath}");
    }
}