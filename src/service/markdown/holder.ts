import * as vscode from 'vscode';

/**
 * Holds the active markdown document information
 * Compatible with both CustomTextEditorProvider and CustomReadonlyEditorProvider
 */
export class Holder {
    public static activeDocument: vscode.TextDocument | null;

    // For CustomReadonlyEditorProvider compatibility
    public static activeUri: vscode.Uri | null;
    public static activeContent: string | null;
}
