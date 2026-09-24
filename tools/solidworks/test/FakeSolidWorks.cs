// Stand-in for the SOLIDWORKS COM objects, with exactly the members
// SwConvert.ConvertWith uses. It records what it was asked and "exports" by
// copying a real STEP file, so the conversion logic can be tested anywhere.
using System;
using System.Collections.Generic;
using System.IO;

public class FakeExtension
{
    public FakeSolidWorks Owner;
    public bool SaveAs(string name, int version, int options, object data, ref int errors, ref int warnings)
    {
        Owner.Calls.Add("Extension.SaveAs|" + options);
        if (Owner.Mode == "saveas-throws") throw new InvalidOperationException("Type mismatch (simulated)");
        if (Owner.Mode != "no-output") File.Copy(Owner.Step, name, true);
        errors = 0;
        return true;
    }
}

public class FakeDoc
{
    public FakeSolidWorks Owner;
    public string Path;
    public FakeExtension Extension;
    public string GetTitle() { return System.IO.Path.GetFileName(Path); }
    public int SaveAs3(string name, int version, int options)
    {
        Owner.Calls.Add("SaveAs3|" + options);
        if (Owner.Mode != "no-output") File.Copy(Owner.Step, name, true);
        return 0;
    }
}

public class FakeSolidWorks
{
    public string Mode = "ok";
    public string Step;
    public List<string> Calls = new List<string>();

    public FakeDoc OpenDoc6(string path, int type, int options, string config, ref int errors, ref int warnings)
    {
        if (Mode == "opendoc6-throws") throw new InvalidOperationException("Type mismatch (simulated)");
        Calls.Add("OpenDoc6|" + System.IO.Path.GetExtension(path) + "|" + type + "|" + options);
        if (Mode == "open-null") { errors = 8192; return null; }
        return NewDoc(path);
    }

    public FakeDoc OpenDoc(string path, int type)
    {
        Calls.Add("OpenDoc|" + System.IO.Path.GetExtension(path) + "|" + type);
        return NewDoc(path);
    }

    public void QuitDoc(string title) { Calls.Add("QuitDoc|" + title); }
    public void CloseDoc(string title) { Calls.Add("CloseDoc|" + title); }

    FakeDoc NewDoc(string path)
    {
        FakeDoc doc = new FakeDoc();
        doc.Owner = this;
        doc.Path = path;
        doc.Extension = new FakeExtension();
        doc.Extension.Owner = this;
        return doc;
    }
}
