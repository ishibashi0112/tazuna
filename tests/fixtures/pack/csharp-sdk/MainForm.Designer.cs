namespace SdkApp;

partial class MainForm
{
    /// <summary>
    ///  Required designer variable.
    /// </summary>
    private System.ComponentModel.IContainer components = null;

    protected override void Dispose(bool disposing)
    {
        if (disposing && (components != null))
        {
            components.Dispose();
        }
        base.Dispose(disposing);
    }

    #region Windows Form Designer generated code

    private void InitializeComponent()
    {
        txtPrice = new TextBox();
        btnCalc = new Button();
        lblResult = new Label();
        grpInput = new GroupBox();
        grpInput.SuspendLayout();
        SuspendLayout();
        // 
        // txtPrice
        // 
        txtPrice.Location = new Point(12, 12);
        txtPrice.Name = "txtPrice";
        txtPrice.Size = new Size(120, 23);
        // 
        // btnCalc
        // 
        btnCalc.Location = new Point(140, 12);
        btnCalc.Name = "btnCalc";
        btnCalc.Text = "計算";
        btnCalc.Click += btnCalc_Click;
        // 
        // lblResult
        // 
        lblResult.Name = "lblResult";
        lblResult.Text = @"結果: ""未計算""";
        // 
        // grpInput
        // 
        grpInput.Controls.Add(txtPrice);
        grpInput.Controls.Add(btnCalc);
        grpInput.Name = "grpInput";
        grpInput.Text = "入力";
        // 
        // MainForm
        // 
        AutoScaleDimensions = new SizeF(7F, 15F);
        AutoScaleMode = AutoScaleMode.Font;
        ClientSize = new Size(400, 200);
        Controls.Add(grpInput);
        Controls.Add(lblResult);
        Name = "MainForm";
        Text = "単価計算";
        Load += MainForm_Load;
        grpInput.ResumeLayout(false);
        ResumeLayout(false);
    }

    #endregion

    private TextBox txtPrice;
    private Button btnCalc;
    private Label lblResult;
    private GroupBox grpInput;
}
