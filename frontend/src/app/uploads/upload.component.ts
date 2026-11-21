import { Component } from '@angular/core';

import { ApiService } from '../api.service';

@Component({
  selector: 'app-upload',
  templateUrl: './upload.component.html',
  styleUrls: ['./upload.component.css']
})

export class UploadComponent {

  selectedFile: any;

  explanation: string = '';

  loading: boolean = false;

  constructor(private apiService: ApiService){}

  onFileChange(event: any){

    this.selectedFile = event.target.files[0];

  }

  uploadFile(){

    if (!this.selectedFile) {

      this.explanation = 'Please choose a file first.';

      return;

    }

    const formData = new FormData();

    formData.append('file', this.selectedFile);

    this.explanation = '';

    this.loading = true;

    this.apiService.uploadFile(formData)
    .subscribe((response: any) => {

      this.apiService.explainFile(this.selectedFile.name)
      .subscribe((result: any) => {

        this.explanation = result.answer;

        this.loading = false;

      }, () => {

        this.explanation = 'Could not get an explanation from the server.';

        this.loading = false;

      });

    }, () => {

      this.explanation = 'File upload failed. Is the backend running on port 3000?';

      this.loading = false;

    });

  }

}